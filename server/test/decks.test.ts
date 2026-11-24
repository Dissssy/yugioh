import { get } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBlocker, deckProblems, isSideSwap, matchesTerms, NO_BANLIST, parseQuery, parseYdk, setTerm, termValue, toYdk, type BanlistDetail, type BanlistSummary, type CatalogCard, type DeckDetail, type DeckList, type DeckSave, type DeckSummary, type DuelDeck, type DuelSummary, type RuleCard } from '@yugioh/shared';
import { eq } from 'drizzle-orm';
import { syncCards, toCardData } from '../src/cards.ts';
import { users } from '../src/db/schema.ts';
import { ADMIN_EMAIL, Browser, startHarness, type Harness } from './harness.ts';

describe('deck rules', () => {
  const cards: Record<number, RuleCard> = {
    1: { name: 'Monster', extraDeck: false, inPool: true },
    2: { name: 'Synchro', extraDeck: true, inPool: true },
    3: { name: 'Unknown', extraDeck: false, inPool: false },
  };
  const deck = (main: number[], extra: number[] = [], side: number[] = []): DeckList => ({ main, extra, side });

  it('says why a card can not be added', () => {
    expect(addBlocker(deck([]), 3, cards[3]!, 'main', NO_BANLIST)).toBe('Not in the game yet');
    expect(addBlocker(deck([]), 2, cards[2]!, 'main', NO_BANLIST)).toBe('Goes in the Extra Deck');
    expect(addBlocker(deck([]), 1, cards[1]!, 'extra', NO_BANLIST)).toBe("Doesn't go in the Extra Deck");
    expect(addBlocker(deck([]), 2, cards[2]!, 'side', NO_BANLIST)).toBeNull();
    expect(addBlocker(deck([1, 1], [], [1]), 1, cards[1]!, 'main', NO_BANLIST)).toBe('You have 3 of 3');
    expect(addBlocker(deck([], [], Array(15).fill(9)), 1, cards[1]!, 'side', NO_BANLIST)).toBe('Side Deck is full');
    expect(addBlocker(deck([1]), 1, cards[1]!, 'main', NO_BANLIST)).toBeNull();
  });

  it('lists what keeps a deck out of a duel', () => {
    const of = (c: number) => cards[c];
    expect(deckProblems(deck(Array(39).fill(1), [1, 4]), of, NO_BANLIST)).toEqual([
      'Main Deck has 39 cards; it needs at least 40',
      '40 copies of Monster; at most 3',
      "Monster doesn't go in the Extra Deck",
      "Card 4 doesn't exist",
    ]);
    const banlist = { name: 'Test', limits: { 1: 1, 2: 0 } };
    expect(deckProblems(deck([1, 1], [2]), of, banlist, { premade: true })).toEqual([
      '2 copies of Monster; Test allows 1',
      'Synchro is Forbidden under Test',
    ]);
  });

  it('says why a banlist keeps a card out', () => {
    const banlist = { name: 'Test', limits: { 1: 1, 2: 0 } };
    expect(addBlocker(deck([]), 2, cards[2]!, 'extra', banlist)).toBe('Forbidden under Test');
    expect(addBlocker(deck([], [], [1]), 1, cards[1]!, 'main', banlist)).toBe('You have 1 of 1');
    expect(addBlocker(deck([]), 1, cards[1]!, 'main', banlist)).toBeNull();
  });
});

let h: Harness;
let premade: DeckSummary[];
let sample: DeckDetail;
beforeAll(async () => {
  h = await startHarness();
  await syncCards(h.db, { imageDir: h.imageDir, api: h.ygoprodeck, imageGapMs: 0 });
  premade = (await new Browser().json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
  sample = (await new Browser().json<DeckDetail>(`${h.baseUrl}/api/decks/${premade[0]!.id}`)).body;
});
afterAll(() => h.close());

async function player(sub: string, username: string) {
  const b = new Browser();
  h.setIdentity({ sub, email: sub === 'admin' ? ADMIN_EMAIL : `${sub}@example.com`, email_verified: true });
  await b.fetch(`${h.baseUrl}/auth/login`);
  await b.json(`${h.baseUrl}/api/me/username`, { method: 'POST', body: JSON.stringify({ username }) });
  await h.db.update(users).set({ status: 'approved' }).where(eq(users.auth0Sub, sub));
  return b;
}

const save = (deck: Partial<DeckSave> = {}): DeckSave => ({
  name: 'Mine',
  main: sample.main.map((c) => c.code),
  extra: sample.extra.map((c) => c.code),
  side: [],
  shared: false,
  banlistId: null,
  ...deck,
});
const post = (b: Browser, path: string, body: unknown, method = 'POST') => b.json<never>(`${h.baseUrl}/api${path}`, { method, body: JSON.stringify(body) });

describe('card data', () => {
  it('takes the type line from typeline, so Extra Deck Effect Monsters say "Effect"', () => {
    const row = { id: 1, name: 'Brionac', type: 'Synchro Monster', frameType: 'synchro', text: '', textHash: '', atk: 2300, def: 1400, level: 6, race: 'Sea Serpent', attribute: 'WATER', archetype: null, raw: { typeline: ['Sea Serpent', 'Synchro', 'Effect'] }, updatedAt: new Date() };
    expect(toCardData(row).type).toBe('Synchro Effect Monster');
    expect(toCardData({ ...row, type: 'Trap Card', frameType: 'trap', raw: {} }).type).toBe('Trap Card');
  });
});

describe('the card catalog', () => {
  it('lists every card, gzipped, with whether it is in the game, and revalidates', async () => {
    const b = new Browser();
    const res = await b.fetch(`${h.baseUrl}/api/cards`, { headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const list = (await res.json()) as CatalogCard[];
    expect(list.length).toBeGreaterThan(sample.main.length);
    expect(list.find((c) => c.code === sample.main[0]!.code)?.inPool).toBe(true);
    expect(list.find((c) => c.code === 6368038)?.altCodes).toEqual([6368039]); // Gaia The Fierce Knight's other artwork
    // fetch() marks conditional requests no-cache, so revalidate the way a browser's cache does.
    const status = await new Promise((resolve) =>
      get(`${h.baseUrl}/api/cards`, { headers: { 'if-none-match': res.headers.get('etag')! } }, (r) => resolve(r.resume().statusCode)),
    );
    expect(status).toBe(304);
  });
});

describe('search terms', () => {
  const card = (c: Partial<CatalogCard>): CatalogCard => ({
    code: 1, name: 'Card', type: 'Effect Monster', kind: 'monster', extraDeck: false, text: '', level: 4, atk: 1000, def: 1000,
    attribute: 'DARK', race: 'Dragon', archetype: null, inPool: true, ...c,
  });
  const cards = [
    card({ code: 1, name: 'Luster Dragon', type: 'Normal Monster', level: 4, atk: 1900, def: 1600, attribute: 'WIND' }),
    card({ code: 2, name: 'Blue-Eyes White Dragon', type: 'Normal Monster', level: 8, atk: 3000, def: 2500, attribute: 'LIGHT', archetype: 'Blue-Eyes' }),
    card({ code: 3, name: 'Junk Synchron', type: 'Tuner Effect Monster', level: 3, atk: 1300, def: 500, race: 'Warrior', text: 'Special Summon 1 Level 2 or lower monster' }),
    card({ code: 4, name: 'Mystical Space Typhoon', type: 'Spell Card', kind: 'spell', level: null, atk: null, def: null, attribute: null, race: 'Quick-Play' }),
  ];
  const find = (text: string) => {
    const q = parseQuery(text);
    return cards.filter((c) => matchesTerms(c, q.terms)).map((c) => c.code);
  };

  it('filters by numbers, comparisons and ranges, leaving the words for the text search', () => {
    expect(parseQuery('dragon atk:>=1800 level:4').words).toBe('dragon');
    expect(find('atk:>=1800')).toEqual([1, 2]);
    expect(find('def:<1000')).toEqual([3]);
    expect(find('level:3-4')).toEqual([1, 3]);
    expect(find('lv:8')).toEqual([2]);
    expect(parseQuery('atk:lots').errors).toHaveLength(1);
  });

  it('filters by attribute, type, kind, archetype and type-line words, and leaves out negated terms', () => {
    expect(find('attr:light')).toEqual([2]);
    expect(find('type:warrior')).toEqual([3]);
    expect(find('type:quick-play')).toEqual([4]);
    expect(find('kind:spell')).toEqual([4]);
    expect(find('arch:"blue-eyes"')).toEqual([2]);
    expect(find('is:tuner')).toEqual([3]);
    expect(find('kind:monster -is:normal')).toEqual([3]);
    expect(find('text:"special summon"')).toEqual([3]);
  });

  it('lets the filter menus read and write terms in the search box', () => {
    expect(setTerm('dragon attr:dark', 'attr', 'LIGHT')).toBe('dragon attr:LIGHT');
    expect(setTerm('dragon attribute:dark', 'attr', null)).toBe('dragon');
    expect(setTerm('', 'arch', 'Dark Magician')).toBe('arch:"Dark Magician"');
    expect(termValue('arch:"Dark Magician" atk:>=1000', 'arch')).toBe('Dark Magician');
    expect(termValue('level:>=4', 'level')).toBeNull();
  });
});

describe('Side Deck swaps', () => {
  it('allows moving cards between the Side Deck and the rest one for one', () => {
    const deck = { main: [1, 2], extra: [3], side: [4] };
    expect(isSideSwap(deck, { main: [4, 1], extra: [3], side: [2] })).toBe(true);
    expect(isSideSwap(deck, { main: [1, 2, 4], extra: [3], side: [] })).toBe(false);
    expect(isSideSwap(deck, { main: [1, 2], extra: [3], side: [5] })).toBe(false);
  });
});

describe('.ydk files', () => {
  const known: Record<number, boolean> = { 1: false, 2: false, 3: true };
  const resolve = (code: number) => (code === 9 ? { code: 1, extraDeck: false } : code in known ? { code, extraDeck: known[code]! } : undefined);

  it('round-trips a deck', () => {
    const deck = { main: [1, 1, 2], extra: [3], side: [2] };
    expect(parseYdk(toYdk(deck), resolve)).toEqual({ ...deck, unknown: [] });
  });

  it('reads alternate artworks, sorts Main and Extra Deck cards by kind, and leaves out unknown passcodes', () => {
    const text = '#created by someone\r\n#main\r\n9\r\n3\r\n77\r\n#extra\r\n2\r\n!side\r\n3\r\n';
    expect(parseYdk(text, resolve)).toEqual({ main: [1, 2], extra: [3], side: [3], unknown: [77] });
  });
});

describe("players' decks", () => {
  it('only approved accounts save decks', async () => {
    expect((await post(new Browser(), '/decks', save())).status).toBe(403);
  });

  it('saves a deck whatever its state, and lists its problems', async () => {
    const ethan = await player('admin', 'Ethan');
    const draft = await post(ethan, '/decks', save({ main: sample.main.slice(0, 10).map((c) => c.code) }));
    expect(draft.status).toBe(201);
    expect((draft.body as DeckSummary).problems).toEqual(['Main Deck has 10 cards; it needs at least 40']);
    expect((await post(ethan, '/decks', save({ main: [-5] }))).status).toBe(400);
    const list = (await ethan.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
    expect(list.map((d) => d.premade)).toEqual([false, ...premade.map(() => true)]);
  });

  it("keeps a deck private until it's shared, and only its owner edits it", async () => {
    const ethan = await player('admin', 'Ethan');
    const yugi = await player('yugi', 'Yugi');
    const deck = (await post(ethan, '/decks', save())).body as DeckSummary;
    expect((await yugi.json(`${h.baseUrl}/api/decks/${deck.id}`)).status).toBe(404);
    expect((await post(yugi, `/decks/${deck.id}`, save({ name: 'Stolen' }), 'PUT')).status).toBe(404);
    expect((await post(ethan, `/decks/${deck.id}`, save({ shared: true }), 'PUT')).status).toBe(200);
    const seen = await new Browser().json<DeckDetail>(`${h.baseUrl}/api/decks/${deck.id}`);
    expect(seen.body).toMatchObject({ mine: false, shared: true, premade: false, name: 'Mine' });
    expect((await ethan.json<DeckDetail>(`${h.baseUrl}/api/decks/${deck.id}`)).body.mine).toBe(true);
    expect((await yugi.fetch(`${h.baseUrl}/api/decks/${deck.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('brings a copy of a deck into a duel, which must follow the rules before the player is ready', async () => {
    const ethan = await player('admin', 'Ethan');
    const yugi = await player('yugi', 'Yugi');
    const draft = (await post(ethan, '/decks', save({ main: [] }))).body as DeckSummary;
    const deck = (await post(ethan, '/decks', save({ name: 'Synchro Speed' }))).body as DeckSummary;
    const duel = (await post(ethan, '/duels', {})).body as DuelSummary;
    expect((await post(yugi, `/duels/${duel.id}/join`, {})).status).toBe(200);
    expect((await post(yugi, `/duels/${duel.id}/deck`, { deckId: deck.id }, 'PUT')).status).toBe(404);
    expect((await post(ethan, `/duels/${duel.id}/deck`, { deckId: draft.id }, 'PUT')).status).toBe(200);
    expect((await post(ethan, `/duels/${duel.id}/ready`, { ready: true })).status).toBe(422);
    expect((await post(ethan, `/duels/${duel.id}/deck`, { deckId: deck.id }, 'PUT')).status).toBe(200);
    // Editing or deleting the deck afterwards doesn't touch the duel.
    expect((await post(ethan, `/decks/${deck.id}`, save({ name: 'Renamed', main: [] }), 'PUT')).status).toBe(200);
    await post(yugi, `/duels/${duel.id}/deck`, { deckId: premade[1]!.id }, 'PUT');
    expect((await post(yugi, `/duels/${duel.id}/ready`, { ready: true })).status).toBe(200);
    expect((await post(ethan, `/duels/${duel.id}/ready`, { ready: true })).status).toBe(200);
    expect((await ethan.fetch(`${h.baseUrl}/api/decks/${deck.id}`, { method: 'DELETE' })).status).toBe(204);
    const after = (await ethan.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}`)).body;
    expect(after).toMatchObject({ status: 'active', players: [{ deck: 'Synchro Speed' }, { deck: premade[1]!.name }] });
  });

  it('keeps a premade-only challenge to premade decks, changed only by Side Deck swaps', async () => {
    const ethan = await player('admin', 'Ethan');
    const yugi = await player('yugi', 'Yugi');
    const own = (await post(yugi, '/decks', save())).body as DeckSummary;
    const duel = (await post(ethan, '/duels', { premadeOnly: true })).body as DuelSummary;
    expect(duel.premadeOnly).toBe(true);
    await post(yugi, `/duels/${duel.id}/join`, {});
    expect((await post(yugi, `/duels/${duel.id}/deck`, { deckId: own.id }, 'PUT')).status).toBe(422);
    const { deck } = (await post(yugi, `/duels/${duel.id}/deck`, { deckId: premade[1]!.id }, 'PUT')).body as { deck: DuelDeck };
    const reordered = { name: deck.name, main: deck.main.toReversed(), extra: deck.extra, side: deck.side };
    expect(((await post(yugi, `/duels/${duel.id}/deck`, reordered, 'PUT')).body as { deck: DuelDeck }).deck.premade).toBe(true);
    const sided = { ...reordered, main: deck.main.slice(1), side: [...deck.side, deck.main[0]!] };
    expect((await post(yugi, `/duels/${duel.id}/deck`, sided, 'PUT')).status).toBe(422);
    expect((await post(yugi, `/duels/${duel.id}/ready`, { ready: true })).status).toBe(200);
  });
});

describe('banlists', () => {
  it('has the default lists from the card import, for anyone', async () => {
    const lists = (await new Browser().json<BanlistSummary[]>(`${h.baseUrl}/api/banlists`)).body;
    expect(lists.map((l) => [l.name, l.isDefault])).toEqual([
      ['TCG', true],
      ['OCG', true],
      ['Goat', true],
      ['No list', true],
    ]);
    const goat = (await new Browser().json<BanlistDetail>(`${h.baseUrl}/api/banlists/${lists[2]!.id}`)).body;
    expect(Object.values(goat.limits).length).toBeGreaterThan(0);
    expect(lists[3]!.listed).toBe(0);
  });

  it('keeps a list private until shared, and checks decks and duels against it', async () => {
    const ethan = await player('admin', 'Ethan');
    const yugi = await player('yugi', 'Yugi');
    const banned = sample.main[0]!.code;
    const created = await post(ethan, '/banlists', { name: 'House rules', limits: { [banned]: 0 }, shared: false });
    expect(created.status).toBe(201);
    const list = created.body as BanlistSummary;
    expect((await yugi.json(`${h.baseUrl}/api/banlists/${list.id}`)).status).toBe(404);
    expect((await post(yugi, '/duels', { banlistId: list.id })).status).toBe(404);
    expect((await post(ethan, '/banlists', { name: 'Bad', limits: { [banned]: 3 }, shared: false })).status).toBe(400);

    // The decks list checks against a list when asked, and a deck saved for the list is checked against it.
    const deck = (await post(ethan, '/decks', save({ banlistId: list.id }))).body as DeckSummary;
    expect(deck.problems).toEqual([`${sample.main[0]!.name} is Forbidden under House rules`]);
    const yugiDeck = (await post(yugi, '/decks', save())).body as DeckSummary;
    expect(yugiDeck.problems).toEqual([]);
    const underIt = (await ethan.json<DeckSummary[]>(`${h.baseUrl}/api/decks?banlist=${list.id}`)).body;
    // Premade decks follow the list too, but not the section sizes.
    expect(underIt.find((d) => d.id === premade[0]!.id)?.problems).toEqual([`${sample.main[0]!.name} is Forbidden under House rules`]);

    const duel = (await post(ethan, '/duels', { banlistId: list.id })).body as DuelSummary;
    expect(duel.banlist).toBe('House rules');
    await post(yugi, `/duels/${duel.id}/join`, {});
    // Yugi can't see the list, but picks a deck for the duel under it.
    const forDuel = (await yugi.json<DeckSummary[]>(`${h.baseUrl}/api/decks?duel=${duel.id}`)).body;
    expect(forDuel.find((d) => d.id === yugiDeck.id)?.problems).toHaveLength(1);
    const ready = async (deckId: number) => {
      await post(yugi, `/duels/${duel.id}/deck`, { deckId }, 'PUT');
      return post(yugi, `/duels/${duel.id}/ready`, { ready: true });
    };
    expect((await ready(yugiDeck.id)).body).toEqual({ error: `${sample.main[0]!.name} is Forbidden under House rules` });
    // The duel keeps its copy of the list, so deleting the list changes nothing.
    expect((await ethan.fetch(`${h.baseUrl}/api/banlists/${list.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await ready(yugiDeck.id)).status).toBe(422);
    expect((await ready(premade[0]!.id)).status).toBe(422);
    expect((await ready(premade[1]!.id)).status).toBe(200);
  });
});
