// A card effect end to end over HTTP: activation, the judge asking a player, resolution, and a contest.
import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDuel, type DuelEvent, type DuelUpdate, type LogEntry } from '@yugioh/engine';
import type { DeckSummary, DuelSummary } from '@yugioh/shared';
import { loadCards, syncCards } from '../src/cards.ts';
import { decks, matchEvents } from '../src/db/schema.ts';
import type { ModelCall } from '../src/judge/judge.ts';
import { loadSheets } from '../src/sheets.ts';
import { ADMIN_EMAIL, Browser, startHarness, Stream, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
  await syncCards(h.db, { imageDir: h.imageDir, api: h.ygoprodeck, imageGapMs: 0 });
});
afterAll(() => h.close());

const POISON = 8842266; // Poison of the Old Man: gain 1200 LP or inflict 800 damage.
const RETURNING = 95281259; // The Warrior Returning Alive: add a Warrior from your GY to your hand.

type Call = { name: string; input: unknown };
const message = (model: string, content: unknown[], stop = 'tool_use') =>
  ({ id: 'msg', type: 'message', role: 'assistant', model, stop_reason: stop, stop_sequence: null, content, usage: { input_tokens: 0, output_tokens: 0 } }) as unknown as Anthropic.Message;
const tools = (model: string, calls: Call[]) => message(model, calls.map((c, i) => ({ type: 'tool_use', id: `tu${i}`, name: c.name, input: c.input })));

/** Reads updates until one matches. */
async function until<T>(stream: Stream, pick: (u: DuelUpdate) => T | undefined): Promise<T> {
  for (;;) {
    const found = pick(await stream.update());
    if (found !== undefined) return found;
  }
}
const entries = (u: DuelUpdate): LogEntry[] => (u.type === 'steps' ? u.steps.map((s) => s.entry) : []);

describe('a card effect', () => {
  let admin: Browser;
  let guest: Browser;
  let duel: DuelSummary;
  let poison: string;
  let returning: string;

  it('sets up a duel where the guest goes first holding Poison of the Old Man', async () => {
    admin = await login();
    const deckList = (await admin.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
    duel = (await admin.json<DuelSummary>(`${h.baseUrl}/api/duels`, { method: 'POST', body: JSON.stringify({ deckId: deckList[0]!.id }) })).body;
    guest = new Browser();
    await guest.json(`${h.baseUrl}/api/duels/${duel.id}/join`, { method: 'POST', body: JSON.stringify({ deckId: deckList[1]!.id, guestName: 'Kaiba' }) });

    // Replace the dealt duel with one where the guest goes first with Poison in their hand.
    const [d0, d1] = await Promise.all(deckList.map((d) => h.db.query.decks.findFirst({ where: eq(decks.id, d.id) })));
    const cards = await loadCards(h.db, [...d0!.main, ...d0!.extra, ...d1!.main, ...d1!.extra]);
    const [dealt] = startDuel(
      { players: [{ name: 'Ethan', main: d0!.main, extra: d0!.extra }, { name: 'Kaiba (guest)', main: d1!.main, extra: d1!.extra }], cards, sheets: await loadSheets(cards) },
      Math.random,
    );
    const start = { ...(dealt as Extract<DuelEvent, { type: 'duelStarted' }>), first: 1 as const };
    poison = start.players[1].deck.find((id) => start.instances[id]!.code === POISON)!;
    returning = start.players[1].deck.find((id) => start.instances[id]!.code === RETURNING)!;
    const events: DuelEvent[] = [
      start,
      { type: 'drew', player: 1, count: 5 },
      { type: 'drew', player: 0, count: 5 },
      { type: 'turnStarted', player: 1, turn: 1 },
      { type: 'phaseChanged', phase: 'main1' },
    ];
    if (!start.players[1].deck.slice(0, 5).includes(poison)) {
      events.push({ type: 'moved', card: poison, owner: 1, from: 'deck', to: 'hand' });
    }
    if (!start.players[1].deck.slice(0, 5).includes(returning)) {
      events.push({ type: 'moved', card: returning, owner: 1, from: 'deck', to: 'hand' });
    }
    await h.db.delete(matchEvents).where(eq(matchEvents.matchId, duel.id));
    await h.db.insert(matchEvents).values(events.map((event, seq) => ({ matchId: duel.id, seq, event })));
  });

  it('activates, asks the player to choose, resolves, and logs the ruling', async () => {
    let judgeCalls = 0;
    const model: ModelCall = async (params) => {
      judgeCalls++;
      const request = params.messages[0]!.content as string;
      const turn = params.messages.filter((m) => m.role === 'assistant').length;
      if (request.includes('check an activation')) return tools(params.model, [{ name: 'finish', input: { legal: true, summary: 'Poison of the Old Man is activated.' } }]);
      if (turn === 0) {
        return tools(params.model, [
          { name: 'ask_player', input: { player: 1, prompt: 'Choose an effect.', cards: [], choices: ['Gain 1200 LP', 'Inflict 800 damage'], min: 1, max: 1 } },
        ]);
      }
      return tools(params.model, [
        { name: 'change_lp', input: { player: 0, amount: 800, kind: 'damage' } },
        { name: 'finish', input: { legal: true, summary: 'Ethan took 800 damage.' } },
      ]);
    };
    h.setModel(model);
    const mine = new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    const theirs = new Stream(await admin.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    const sync = await mine.update();
    if (sync.type !== 'sync') throw new Error('expected sync');
    const action = sync.view.actions.find((a) => a.type === 'activate' && a.card === poison);
    expect(action).toMatchObject({ effect: 0, zones: [0, 1, 2, 3, 4], text: expect.stringContaining('1200 LP') });

    const sent = await guest.json(`${h.baseUrl}/api/duels/${duel.id}/intents`, {
      method: 'POST',
      body: JSON.stringify({ type: 'activate', card: poison, effect: 0, zone: 2 }),
    });
    expect(sent.status).toBe(204);

    const prompt = await until(mine, (u) => (u.type === 'judging' ? (u.judging?.prompt ?? undefined) : undefined));
    expect(prompt).toMatchObject({ text: 'Choose an effect.', choices: ['Gain 1200 LP', 'Inflict 800 damage'], min: 1, max: 1 });
    const opponentSees = await until(theirs, (u) => (u.type === 'judging' && u.judging?.waitingOn === 1 ? u.judging : undefined));
    expect(opponentSees).toMatchObject({ stage: 'resolution', prompt: null, card: { id: poison } });

    const answer = (picks: string[]) =>
      guest.json(`${h.baseUrl}/api/duels/${duel.id}/answer`, { method: 'POST', body: JSON.stringify({ prompt: prompt.id, picks }) });
    expect((await answer(['Steal the duel'])).status).toBe(422);
    expect((await answer(['Inflict 800 damage'])).status).toBe(204);

    const resolved = await until(theirs, (u) => (entries(u).some((e) => e.event.type === 'linkResolved') ? u : undefined));
    if (resolved.type !== 'steps') throw new Error('expected steps');
    expect(entries(resolved).map((e) => e.text).filter(Boolean)).toEqual(['Ethan took 800 damage.', 'Ethan took 800 damage']);
    const after = resolved.steps.at(-1)!.view;
    expect(after.players[0].lp).toBe(7200);
    expect(after.players[1].graveyard.map((c) => ('id' in c ? c.id : null))).toEqual([poison]);
    expect(after.chain).toEqual([]);
    expect(judgeCalls).toBe(3);

    // The activation's ruling and the resolution's are both in the log, with what players may see of them.
    const log = await until(new Stream(await admin.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`)), (u) => (u.type === 'sync' ? u.log : undefined));
    const rulings = log.filter((e) => e.event.type === 'judged');
    expect(rulings.map((e) => e.event)).toEqual([
      { type: 'judged', stage: 'activation', player: 1, card: null, legal: true, summary: 'Poison of the Old Man is activated.', failed: false },
      { type: 'judged', stage: 'resolution', player: 1, card: poison, legal: true, summary: 'Ethan took 800 damage.', failed: false },
    ]);
    expect(JSON.stringify(log)).not.toContain('transcript');

    // Contesting the resolution runs the appeal, whose verdict joins both logs.
    h.setModel(async (params) => {
      expect(params.model).toBe('claude-opus-5-5');
      expect(JSON.stringify(params.messages)).toContain('Inflict 800 damage');
      return message(params.model, [{ type: 'text', text: JSON.stringify({ verdict: 'upheld', explanation: 'The player chose the damage option.', ruling: 'Correct.' }) }], 'end_turn');
    });
    const contest = (note: string) =>
      admin.json(`${h.baseUrl}/api/duels/${duel.id}/contest`, { method: 'POST', body: JSON.stringify({ seq: rulings[1]!.seq, note }) });
    expect((await contest('That should have been a gain.')).status).toBe(202);
    const verdict = await until(mine, (u) => entries(u).find((e) => e.event.type === 'appealed'));
    expect(verdict.event).toEqual({ type: 'appealed', judged: rulings[1]!.seq, by: 0, verdict: 'upheld', explanation: 'The player chose the damage option.' });
    expect(verdict.text).toBe('Appeal upheld the ruling: The player chose the damage option.');
    expect((await contest('again')).status).toBe(409);
    mine.close();
    theirs.close();
  });

  it("keeps a refused activation's card in the hand, and the opponent learns nothing", async () => {
    h.setModel(async (params) => tools(params.model, [{ name: 'finish', input: { legal: false, summary: 'There is no Warrior in your GY.' } }]));
    const mine = new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    const theirs = new Stream(await admin.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    await mine.update();
    await theirs.update();
    const sent = await guest.json(`${h.baseUrl}/api/duels/${duel.id}/intents`, {
      method: 'POST',
      body: JSON.stringify({ type: 'activate', card: returning, effect: 0, zone: 0 }),
    });
    expect(sent.status).toBe(204);
    const refused = await until(mine, (u) => entries(u).find((e) => e.event.type === 'judged'));
    expect(refused.event).toMatchObject({ legal: false, card: returning, summary: 'There is no Warrior in your GY.' });
    const opponent = await until(theirs, (u) => (u.type === 'judging' ? u.judging : undefined));
    expect(opponent).toMatchObject({ stage: 'activation', player: 1, card: { hidden: true } });
    const log = await until(new Stream(await admin.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`)), (u) => (u.type === 'sync' ? u.log : undefined));
    expect(log.filter((e) => e.event.type === 'judged')).toHaveLength(2);
    expect(JSON.stringify(log)).not.toContain(returning);
    const view = await until(new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`)), (u) => (u.type === 'sync' ? u.view : undefined));
    expect(view.players[1].hand.some((c) => 'id' in c && c.id === returning)).toBe(true);
    expect(view.players[1].spellTraps.every((z) => z === null)).toBe(true);
    mine.close();
    theirs.close();
  });

  it('answers a repeat of a refused activation from the ruling, without the judge, until the board changes', async () => {
    let judgeCalls = 0;
    h.setModel(async (params) => (judgeCalls++, tools(params.model, [{ name: 'finish', input: { legal: false, summary: 'There is no Warrior in your GY.' } }])));
    const view = await until(new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`)), (u) => (u.type === 'sync' ? u.view : undefined));
    expect(view.actions.some((a) => a.type === 'activate' && a.card === returning)).toBe(false);
    expect(view.actions.some((a) => a.type === 'setSpellTrap' && a.card === returning)).toBe(true);
    const again = await guest.json<{ error: string }>(`${h.baseUrl}/api/duels/${duel.id}/intents`, {
      method: 'POST',
      body: JSON.stringify({ type: 'activate', card: returning, effect: 0, zone: 1 }),
    });
    expect(again.status).toBe(422);
    expect(again.body.error).toMatch(/There is no Warrior in your GY\./);
    expect(judgeCalls).toBe(0);

    const mine = new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    await mine.update();
    // Setting the card changes the board, so the judge may be asked again.
    await guest.json(`${h.baseUrl}/api/duels/${duel.id}/intents`, { method: 'POST', body: JSON.stringify({ type: 'setSpellTrap', card: returning, zone: 1 }) });
    const after = await until(mine, (u) => (u.type === 'steps' ? u.steps.at(-1)!.view : undefined));
    expect(after.actions.some((a) => a.type === 'activate' && a.card === returning)).toBe(true);
    mine.close();
  });

  it('binds the next try of a refused activation to the appeal that overturned the refusal', async () => {
    const requests: string[] = [];
    const refuse: ModelCall = async (params) => {
      if (params.messages.length === 1) requests.push(params.messages[0]!.content as string);
      return tools(params.model, [{ name: 'finish', input: { legal: false, summary: 'There is no Warrior in your GY.' } }]);
    };
    h.setModel(refuse);
    const mine = new Stream(await guest.fetch(`${h.baseUrl}/api/duels/${duel.id}/stream`));
    await mine.update();
    const activate = () =>
      guest.json(`${h.baseUrl}/api/duels/${duel.id}/intents`, { method: 'POST', body: JSON.stringify({ type: 'activate', card: returning, effect: 0, zone: null }) });
    expect((await activate()).status).toBe(204);
    const refused = await until(mine, (u) => entries(u).find((e) => e.event.type === 'judged'));

    h.setModel(async (params) =>
      message(params.model, [{ type: 'text', text: JSON.stringify({ verdict: 'overturned', explanation: 'A Warrior is in the GY.', ruling: 'Exiled Force is a legal target.' }) }], 'end_turn'),
    );
    const contest = await guest.json(`${h.baseUrl}/api/duels/${duel.id}/contest`, { method: 'POST', body: JSON.stringify({ seq: refused.seq, note: 'There is a Warrior.' }) });
    expect(contest.status).toBe(202);
    await until(mine, (u) => entries(u).find((e) => e.event.type === 'appealed'));

    // The judge is asked again, told the appeal binds, and its refusal is turned back.
    h.setModel(refuse);
    expect((await activate()).status).toBe(204);
    const retried = await until(mine, (u) => entries(u).find((e) => e.event.type === 'judged'));
    expect(requests.at(-1)).toContain('that ruling binds: Exiled Force is a legal target.');
    expect(retried.event).toMatchObject({ legal: false, failed: true });
    mine.close();
  });
});

async function login() {
  const b = new Browser();
  h.setIdentity({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true });
  await b.fetch(`${h.baseUrl}/auth/login`);
  await b.json(`${h.baseUrl}/api/me/username`, { method: 'POST', body: JSON.stringify({ username: 'Ethan' }) });
  return b;
}
