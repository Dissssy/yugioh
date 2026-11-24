// Chains over HTTP: response windows the server closes by itself, a trap answering an attack, and scripted triggers.
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { evolve, replay, startDuel, statsOf, type DuelEvent, type DuelState, type DuelUpdate, type Intent, type PlayerView, type Seat } from '@yugioh/engine';
import type { DeckSummary, DuelSummary } from '@yugioh/shared';
import { loadCards, syncCards } from '../src/cards.ts';
import { decks, effectSheets, matchEvents } from '../src/db/schema.ts';
import { rule } from '../src/judge/script.ts';
import { flagScripts, importSheetFiles, loadSheets } from '../src/sheets.ts';
import { ADMIN_EMAIL, Browser, seeded, startDuelVia, startHarness, Stream, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  await syncCards(h.db, { imageDir: h.imageDir, api: h.ygoprodeck, imageGapMs: 0 });
  await importSheetFiles(h.db, { force: true });
  h.setModel(async () => {
    throw new Error('Every effect in these tests is scripted; none may call the model.');
  });
});
afterAll(() => h.close());

const SPEED_WARRIOR = 9365703;
const MAGNA_DRAGO = 36750412;
const COPYCAT = 26376390;
const TRAP_HOLE = 4206964;
const MIRROR_FORCE = 44095762;
const ZUBABA = 97896503; // Zubaba Knight, 1600 ATK.

async function login() {
  const b = new Browser();
  h.setIdentity({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true });
  await b.fetch(`${h.baseUrl}/auth/login`);
  await b.json(`${h.baseUrl}/api/me/username`, { method: 'POST', body: JSON.stringify({ username: 'Ethan' }) });
  return b;
}

/**
 * A duel on turn 3, the admin's (seat 0, the 5D's deck) Main Phase 1, holding Speed Warrior, Magna Drago and
 * Copycat. The guest (seat 1, the Xyz deck) Set Mirror Force and Trap Hole and Normal Summoned Zubaba Knight on turn 2.
 */
async function setUp() {
  const admin = await login();
  const deckList = (await admin.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
  const guest = new Browser();
  const duel = await startDuelVia(h.baseUrl, admin, guest, [deckList[0]!.id, deckList[1]!.id], { guestName: 'Kaiba' });
  const [d0, d1] = await Promise.all(deckList.map((d) => h.db.query.decks.findFirst({ where: eq(decks.id, d.id) })));
  const cards = await loadCards(h.db, [...d0!.main, ...d0!.extra, ...d1!.main, ...d1!.extra]);
  const sheets = await loadSheets(h.db, cards);
  const [dealt] = startDuel(
    { players: [{ name: 'Ethan', main: d0!.main, extra: d0!.extra }, { name: 'Kaiba (guest)', main: d1!.main, extra: d1!.extra }], cards, sheets },
    seeded(1),
  );
  const start = dealt as Extract<DuelEvent, { type: 'duelStarted' }>;
  const find = (seat: Seat, code: number) => start.players[seat].deck.find((id) => start.instances[id]!.code === code)!;
  const ids = {
    speedWarrior: find(0, SPEED_WARRIOR),
    magnaDrago: find(0, MAGNA_DRAGO),
    copycat: find(0, COPYCAT),
    mirrorForce: find(1, MIRROR_FORCE),
    trapHole: find(1, TRAP_HOLE),
    zubaba: find(1, ZUBABA),
  };
  const toHand = (seat: Seat, card: string): DuelEvent => ({ type: 'moved', card, owner: seat, from: 'deck', to: 'hand' });
  const events: DuelEvent[] = [
    start,
    { type: 'turnStarted', player: 1, turn: 2 },
    { type: 'phaseChanged', phase: 'main1' },
    toHand(1, ids.mirrorForce),
    toHand(1, ids.trapHole),
    toHand(1, ids.zubaba),
    { type: 'spellTrapSet', player: 1, card: ids.mirrorForce, zone: 0 },
    { type: 'spellTrapSet', player: 1, card: ids.trapHole, zone: 1 },
    { type: 'normalSummoned', player: 1, card: ids.zubaba, zone: 0, extra: null },
    { type: 'turnStarted', player: 0, turn: 3 },
    { type: 'phaseChanged', phase: 'main1' },
    toHand(0, ids.speedWarrior),
    toHand(0, ids.magnaDrago),
    toHand(0, ids.copycat),
  ];
  await h.rewriteLog(duel.id, events);
  const send = (who: Browser, intent: Intent) => who.json<{ error?: string }>(`${h.baseUrl}/api/duels/${duel.id}/intents`, { method: 'POST', body: JSON.stringify(intent) });
  const stream = async (who: Browser) => new Stream(await who.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
  return { admin, guest, duel, ids, send, stream, state: () => replay(events) };
}

/** Reads a stream until the board satisfies `done`. */
async function until(stream: Stream, done: (view: PlayerView, update: DuelUpdate) => boolean): Promise<PlayerView> {
  for (;;) {
    const update = await stream.update();
    if (update.type === 'judging') continue;
    const view = update.type === 'sync' ? update.view : update.steps.at(-1)!.view;
    if (done(view, update)) return view;
  }
}

describe('a duel with chains', () => {
  it('passes for a player who holds no response, and lets one who does answer an attack with Mirror Force', async () => {
    const { admin, guest, ids, send, stream } = await setUp();
    const mine = await stream(admin);
    const theirs = await stream(guest);
    // Speed Warrior has 900 ATK, too little for Trap Hole: the guest's window closes by itself.
    expect((await send(admin, { type: 'normalSummon', card: ids.speedWarrior, tributes: [], zone: 0 })).status).toBe(204);
    let view = await until(mine, (v) => v.players[0].monsters[0] !== null && v.waiting === null && v.actions.length > 1);
    expect(view.actions).toContainEqual({ type: 'enterBattle' });

    // Its effect needs the Battle Phase; entering it opens the guest a window, which also closes by itself.
    expect(view.actions.some((a) => a.type === 'activate')).toBe(false);
    expect((await send(admin, { type: 'enterBattle' })).status).toBe(204);
    view = await until(mine, (v) => v.phase === 'battle' && v.waiting === null && v.actions.some((a) => a.type === 'activate'));
    expect((await send(admin, { type: 'activate', card: ids.speedWarrior, effect: 0, zone: null })).status).toBe(204);
    view = await until(mine, (v) => v.chain.length === 0 && v.players[0].monsters[0]?.stats?.atk === 1800);

    // The attack opens the guest a window holding Mirror Force; the admin waits on them.
    expect((await send(admin, { type: 'attack', attacker: ids.speedWarrior, target: 0 })).status).toBe(204);
    view = await until(mine, (v) => v.waiting?.player === 1);
    expect(view.waiting).toEqual({ player: 1, for: 'respond', cause: "Speed Warrior's attack on Zubaba Knight" });
    const offered = await until(theirs, (v) => v.waiting?.player === 1 && !!v.waiting.cause?.includes('attack'));
    expect(offered.actions).toEqual(expect.arrayContaining([{ type: 'activate', card: ids.mirrorForce, effect: 0, zones: null, text: expect.any(String) }, { type: 'pass' }]));
    expect(offered.actions.some((a) => a.type === 'activate' && a.card === ids.trapHole)).toBe(false);
    expect((await send(guest, { type: 'activate', card: ids.mirrorForce, effect: 0, zone: null })).status).toBe(204);

    // Mirror Force resolves: Speed Warrior is destroyed and the attack deals no damage.
    view = await until(mine, (v) => v.players[0].graveyard.some((c) => 'id' in c && c.id === ids.speedWarrior) && v.actions.length > 1);
    expect(view.players[1].lp).toBe(8000);
    expect(view.players[1].monsters[0]).not.toBeNull();
    expect(view.actions).toContainEqual({ type: 'enterMain2' });
    mine.close();
    theirs.close();
  });

  it('lets Trap Hole answer a Normal Summon, targeting the summoned monster', async () => {
    const { admin, guest, ids, send, stream } = await setUp();
    const mine = await stream(admin);
    const theirs = await stream(guest);
    expect((await send(admin, { type: 'normalSummon', card: ids.magnaDrago, tributes: [], zone: 0 })).status).toBe(204);
    const offered = await until(theirs, (v) => v.waiting?.player === 1);
    expect(offered.waiting?.cause).toBe('the Normal Summon of Magna Drago');
    expect((await send(guest, { type: 'activate', card: ids.trapHole, effect: 0, zone: null })).status).toBe(204);
    const view = await until(mine, (v) => v.players[0].graveyard.some((c) => 'id' in c && c.id === ids.magnaDrago) && v.chain.length === 0);
    expect(view.players[0].monsters.every((m) => m === null)).toBe(true);
    mine.close();
    theirs.close();
  });

  it('lets a player who could respond pass instead', async () => {
    const { admin, guest, ids, send, stream } = await setUp();
    const mine = await stream(admin);
    const theirs = await stream(guest);
    expect((await send(admin, { type: 'normalSummon', card: ids.magnaDrago, tributes: [], zone: 0 })).status).toBe(204);
    await until(theirs, (v) => v.waiting?.player === 1 && v.actions.some((a) => a.type === 'pass'));
    expect((await send(guest, { type: 'pass' })).status).toBe(204);
    const view = await until(mine, (v) => v.players[0].monsters[0] !== null && v.waiting === null && v.actions.length > 1);
    expect(view.chain).toEqual([]);
    expect(view.players[1].spellTraps[1]).not.toBeNull();
    mine.close();
    theirs.close();
  });
});

describe('scripted triggers', () => {
  /** Runs a link's activation then resolution by its script, answering each question with the first option. */
  async function runLink(state: DuelState): Promise<DuelState> {
    const ask = async (q: { cards: { id: string }[]; choices: string[]; min: number }) => [...q.cards.map((c) => c.id), ...q.choices].slice(0, Math.max(1, q.min));
    const deps = { model: null, ask, random: () => 0.5 };
    const activated = await rule({ stage: 'activation', state, link: state.chain.at(-1)! }, deps);
    expect(activated.record).toMatchObject({ model: 'script', legal: true, error: null });
    let s = activated.events.reduce(evolve, state);
    const resolved = await rule({ stage: 'resolution', state: s, link: s.chain.at(-1)! }, deps);
    expect(resolved.record.error).toBeNull();
    s = [...resolved.events, { type: 'linkResolved' } as DuelEvent].reduce(evolve, s);
    return s;
  }

  it("makes Copycat's ATK and DEF the target's original ones, and Magna Drago gain 200 ATK", async () => {
    const { ids, state } = await setUp();
    // Copycat is Summoned by an effect; its trigger targets Zubaba Knight.
    let s = evolve(state(), { type: 'specialSummoned', player: 0, card: ids.copycat, zone: 0, position: 'attack' });
    s = evolve(s, { type: 'checkpoint', cause: null, then: { do: 'open' } });
    s = evolve(s, { type: 'effectActivated', player: 0, card: ids.copycat, effect: 0, zone: null, cause: s.happened[0]! });
    s = await runLink(s);
    expect(statsOf(s, ids.copycat)).toMatchObject({ atk: 1600, def: 900 });

    s = evolve(s, { type: 'normalSummoned', player: 0, card: ids.magnaDrago, zone: 1, extra: null });
    s = evolve(s, { type: 'effectActivated', player: 0, card: ids.magnaDrago, effect: 0, zone: null, cause: null });
    s = await runLink(s);
    expect(statsOf(s, ids.magnaDrago).atk).toBe(1600);
  });
});

describe('effect sheets stored in an older format', () => {
  it('are never played, and the next import replaces them from the files', async () => {
    // Mirror Force as stored before `when` existed: activatable at any time a Trap could be.
    const current = (await h.db.query.effectSheets.findFirst({ where: eq(effectSheets.code, MIRROR_FORCE) }))!.sheet;
    const old = { ...current, effects: current.effects.map(({ when: _, ...e }) => ({ ...e, respondsTo: 'attack' })) };
    await h.db.update(effectSheets).set({ sheet: old as unknown as typeof current }).where(eq(effectSheets.code, MIRROR_FORCE));
    const cards = await loadCards(h.db, [MIRROR_FORCE]);

    expect(await loadSheets(h.db, cards)).toEqual({});
    expect(await importSheetFiles(h.db)).toBe(1);
    expect((await loadSheets(h.db, cards))[MIRROR_FORCE]?.effects[0]?.when?.event).toBe('attack_declared');
  });
});

describe('effect sheets at server start', () => {
  const status = async () => (await loadSheets(h.db, await loadCards(h.db, [MIRROR_FORCE])))[MIRROR_FORCE]?.effects[0]?.status;

  it('import only the files that changed since they were last imported, keeping changes made on the site', async () => {
    await importSheetFiles(h.db, { force: true });
    expect(await importSheetFiles(h.db)).toBe(0);

    await flagScripts(h.db, MIRROR_FORCE, 'test report');
    expect(await importSheetFiles(h.db)).toBe(0);
    expect(await status()).toBe('flagged');

    // A fix to the file reaches the site at the next start.
    await h.db.update(effectSheets).set({ fileHash: 'an older version of the file' }).where(eq(effectSheets.code, MIRROR_FORCE));
    expect(await importSheetFiles(h.db)).toBe(1);
    expect(await status()).toBe('unverified');
  });

  it('never take a sheet away from a running duel, even if the database has none for its cards', async () => {
    const { duel, guest, stream } = await setUp();
    await h.db.delete(effectSheets);
    try {
      // Loading the duel compares its sheets with the database's.
      await (await stream(guest)).update();
      const events = await h.db.select().from(matchEvents).where(eq(matchEvents.matchId, duel.id));
      expect(events.filter((e) => (e.event as DuelEvent).type === 'sheetUpdated')).toEqual([]);
    } finally {
      await importSheetFiles(h.db, { force: true });
    }
  });
});
