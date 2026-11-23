import { get } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBlocker, deckProblems, type CatalogCard, type DeckDetail, type DeckList, type DeckSave, type DeckSummary, type DuelSummary, type RuleCard } from '@yugioh/shared';
import { eq } from 'drizzle-orm';
import { syncCards } from '../src/cards.ts';
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
    expect(addBlocker(deck([]), 3, cards[3]!, 'main')).toBe('Not in the game yet');
    expect(addBlocker(deck([]), 2, cards[2]!, 'main')).toBe('Goes in the Extra Deck');
    expect(addBlocker(deck([]), 1, cards[1]!, 'extra')).toBe("Doesn't go in the Extra Deck");
    expect(addBlocker(deck([]), 2, cards[2]!, 'side')).toBeNull();
    expect(addBlocker(deck([1, 1], [], [1]), 1, cards[1]!, 'main')).toBe('You have 3 of 3');
    expect(addBlocker(deck([], [], Array(15).fill(9)), 1, cards[1]!, 'side')).toBe('Side Deck is full');
    expect(addBlocker(deck([1]), 1, cards[1]!, 'main')).toBeNull();
  });

  it('lists what keeps a deck out of a duel', () => {
    const of = (c: number) => cards[c];
    expect(deckProblems(deck(Array(39).fill(1), [1, 4]), of)).toEqual([
      'Main Deck has 39 cards; it needs at least 40',
      '40 copies of Monster; at most 3',
      "Monster doesn't go in the Extra Deck",
      "Card 4 doesn't exist",
    ]);
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
  ...deck,
});
const post = (b: Browser, path: string, body: unknown, method = 'POST') => b.json<never>(`${h.baseUrl}/api${path}`, { method, body: JSON.stringify(body) });

describe('the card catalog', () => {
  it('lists every card, gzipped, with whether it is in the game, and revalidates', async () => {
    const b = new Browser();
    const res = await b.fetch(`${h.baseUrl}/api/cards`, { headers: { 'accept-encoding': 'gzip' } });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const list = (await res.json()) as CatalogCard[];
    expect(list.length).toBeGreaterThan(sample.main.length);
    expect(list.find((c) => c.code === sample.main[0]!.code)?.inPool).toBe(true);
    // fetch() marks conditional requests no-cache, so revalidate the way a browser's cache does.
    const status = await new Promise((resolve) =>
      get(`${h.baseUrl}/api/cards`, { headers: { 'if-none-match': res.headers.get('etag')! } }, (r) => resolve(r.resume().statusCode)),
    );
    expect(status).toBe(304);
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

  it('brings only legal decks of your own into a duel, as a copy', async () => {
    const ethan = await player('admin', 'Ethan');
    const yugi = await player('yugi', 'Yugi');
    const draft = (await post(ethan, '/decks', save({ main: [] }))).body as DeckSummary;
    expect((await post(ethan, '/duels', { deckId: draft.id })).status).toBe(400);
    const deck = (await post(ethan, '/decks', save({ name: 'Synchro Speed' }))).body as DeckSummary;
    const duel = (await post(ethan, '/duels', { deckId: deck.id })).body as DuelSummary;
    expect(duel.players[0]!.deck).toBe('Synchro Speed');
    expect((await post(yugi, `/duels/${duel.id}/join`, { deckId: deck.id })).status).toBe(404);
    // Editing or deleting the deck afterwards doesn't touch the duel.
    expect((await post(ethan, `/decks/${deck.id}`, save({ name: 'Renamed', main: [] }), 'PUT')).status).toBe(200);
    expect((await post(yugi, `/duels/${duel.id}/join`, { deckId: premade[1]!.id })).status).toBe(200);
    expect((await ethan.fetch(`${h.baseUrl}/api/decks/${deck.id}`, { method: 'DELETE' })).status).toBe(204);
    const after = (await ethan.json<DuelSummary>(`${h.baseUrl}/api/duels/${duel.id}`)).body;
    expect(after).toMatchObject({ status: 'active', players: [{ deck: 'Synchro Speed' }, { deck: premade[1]!.name }] });
  });
});
