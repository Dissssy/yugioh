// The AI opponent (docs/ai-opponent.md), with a stand-in model that picks at random. Whole duels between two AI seats
// run through the real engine and server, so they also test that every move code offers, code accepts.
import type Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reviewLog, type DuelEvent, type DuelUpdate } from '@yugioh/engine';
import { NO_BANLIST, type AdminDuels, type DeckSummary, type DuelSummary } from '@yugioh/shared';
import { syncCards } from '../src/cards.ts';
import { matchEvents, matches, users } from '../src/db/schema.ts';
import { deckForDuel } from '../src/deckRoutes.ts';
import { Duels } from '../src/duels.ts';
import type { ModelCall } from '../src/judge/judge.ts';
import { MISSING_PREFIX, Opponents } from '../src/opponent/opponent.ts';
import { ADMIN_EMAIL, Browser, seeded, startHarness, Stream, type Harness } from './harness.ts';

let h: Harness;
let decks: DeckSummary[];

const duelDeck = (id: number) => deckForDuel(h.db, id, null).then((d) => d!);
let admin: Browser;
beforeAll(async () => {
  h = await startHarness();
  await syncCards(h.db, { imageDir: h.imageDir, api: h.ygoprodeck, imageGapMs: 0 });
  admin = new Browser();
  h.setIdentity({ sub: 'admin', email: ADMIN_EMAIL, email_verified: true });
  await admin.fetch(`${h.baseUrl}/auth/login`);
  decks = (await admin.json<DeckSummary[]>(`${h.baseUrl}/api/decks`)).body;
});
afterAll(() => h.close());

/** The numbered options in the last block of a request, and how many it must pick. */
function optionsAsked(params: Anthropic.MessageCreateParamsNonStreaming) {
  const content = params.messages[0]!.content as Anthropic.TextBlockParam[];
  const ask = content.at(-1)!.text;
  const options = [...ask.matchAll(/^(\d+)\. /gm)].length;
  const between = /Pick between (\d+) and (\d+)/.exec(ask);
  const exactly = /Pick exactly (\d+)/.exec(ask);
  const question = ask.includes('# A question from the judge');
  return { ask, options, question, min: Number(between?.[1] ?? exactly?.[1] ?? 1) };
}

/** A model that picks at random, answering in the opponent's format. */
function randomModel(random: () => number, requests: Anthropic.MessageCreateParamsNonStreaming[] = []): ModelCall {
  return async (params) => {
    const reply = (answer: object) =>
      ({
        id: 'msg',
        type: 'message',
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: JSON.stringify(answer), citations: null }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1000, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000 },
      }) as unknown as Anthropic.Message;
    // An appeal of the AI's contest: always upheld.
    if (typeof params.system === 'string' && params.system.startsWith('You review a contested decision')) {
      return reply({ verdict: 'upheld', explanation: 'The ruling was correct.', ruling: 'Correct as ruled.' });
    }
    requests.push(params);
    const { ask, options, question, min } = optionsAsked(params);
    const pick = () => 1 + Math.floor(random() * options);
    const picks = [...new Set(Array.from({ length: min }, pick))];
    for (let n = 1; picks.length < min; n++) if (!picks.includes(n)) picks.push(n);
    // Contests the first ruling it is shown, and now and then says a move is missing.
    const ruling = /# Rulings you may contest[^\n]*\n[^\n]*\n#(\d+)/.exec(ask);
    const contest = ruling && random() < 0.5 ? { seq: Number(ruling[1]), why: 'I think this is wrong.' } : null;
    const missing = random() < 0.1 ? 'activate a card I hold' : null;
    return reply(question ? { reason: 'random', picks, note: 'note' } : { reason: 'random', choice: pick(), note: `note ${requests.length}`, contest, missing });
  };
}

const eventsOf = async (id: string) => (await h.db.select().from(matchEvents).where(eq(matchEvents.matchId, id)).orderBy(matchEvents.seq)).map((r) => r.event as DuelEvent);

async function finished(id: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const row = await h.db.query.matches.findFirst({ where: eq(matches.id, id) });
    if (row?.status === 'finished') return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  console.log(reviewLog(await eventsOf(id)).slice(-25).map((l) => `#${l.seq} T${l.turn} ${l.text}`).join('\n'));
  return false;
}

describe('playing against Claude', () => {
  it('lets only the admin start a duel against Claude, which then plays its seat', async () => {
    const player = new Browser();
    h.setIdentity({ sub: 'player', email: 'player@example.com', email_verified: true });
    await player.fetch(`${h.baseUrl}/auth/login`);
    const body = JSON.stringify({ deckId: decks[0]!.id, aiDeckId: decks[1]!.id });
    expect((await player.json(`${h.baseUrl}/api/admin/duels/ai`, { method: 'POST', body })).status).toBe(403);

    h.setModel(randomModel(seeded(3)));
    const created = await admin.json<DuelSummary>(`${h.baseUrl}/api/admin/duels/ai`, { method: 'POST', body });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 'active', yourSeat: 0, players: [{ deck: decks[0]!.name }, { name: 'Claude', deck: decks[1]!.name }] });

    // Claude picks rock-paper-scissors as soon as the duel loads, with no model call.
    const stream = new Stream(await admin.fetch(`${h.baseUrl}/api/duels/${created.body.id}/stream`));
    let view = await stream.next();
    expect(view.players[1].name).toBe('Claude');
    while (view.start?.at !== 'rps' || !view.start.theirsIn) view = await stream.next();
    stream.close();
  });

  it('plays whole duels against itself without code refusing a move it offered', async () => {
    const errors = vi.spyOn(console, 'error');
    const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const model = randomModel(seeded(5), requests);
    const ai = { judge: null, appeal: model, judgeCalls: 0, appeals: 10, questions: 20, opponent: { call: model, model: 'claude-haiku-5-5', calls: 60, paceMs: 0 } };
    const duels = new Duels(h.db, ai, seeded(6), 0);
    const opponents = new Opponents(duels, h.db, ai.opponent, 0, seeded(7));
    duels.onAiSeat = (id, seat) => void opponents.attach(id, seat);
    const [owner] = await h.db.select().from(users).where(eq(users.email, ADMIN_EMAIL));

    const ids: string[] = [];
    for (const [a, b] of [[0, 1], [1, 0], [1, 1]] as const) {
      const id = await duels.create(owner!.id, 'ai:a', 'A', NO_BANLIST, false);
      await duels.join(id, async () => ({ key: 'ai:b', name: 'B' }));
      for (const [key, deck] of [['ai:a', a], ['ai:b', b]] as const) {
        const copy = await duelDeck(decks[deck]!.id);
        await duels.setDeck(id, key, () => copy);
        await duels.ready(id, key, true, async () => []);
      }
      ids.push(id);
      // Loading the duel starts both AI seats.
      const updates: DuelUpdate[] = [];
      await duels.watch(id, 0, 0, (u) => updates.push(u));
    }
    for (const id of ids) expect(await finished(id, 60_000)).toBe(true);

    const all = await Promise.all(ids.map(eventsOf));
    expect(all.flat().filter((e) => e.type === 'appealed').length).toBeGreaterThan(0);
    expect(all.flat().some((e) => e.type === 'chatted' && e.text.startsWith(MISSING_PREFIX))).toBe(true);

    const refusals = errors.mock.calls.filter((args) => String(args[0]).includes('but refused it'));
    expect(refusals).toEqual([]);
    errors.mockRestore();

    for (const id of ids) {
      const events = await eventsOf(id);
      const records = events.flatMap((e) => (e.type === 'aiDecided' ? [e.record] : []));
      expect(records.length).toBeGreaterThan(10);
      expect(records.every((r) => r.error === null && r.picks.length > 0)).toBe(true);
      // Each seat stays within its calls; at the limit it surrenders.
      const log = reviewLog(events);
      for (const seat of [0, 1]) {
        expect(records.filter((r) => r.player === seat).length).toBeLessThanOrEqual(60);
        // At most 3 contests a duel, through the appeal flow.
        const appeals = events.filter((e) => e.type === 'appealed' && e.appeal.by === seat);
        expect(appeals.length).toBeLessThanOrEqual(3);
        // Missing moves are said in chat, once a turn each and at most 10 a duel.
        const missing = events.flatMap((e, i) => (e.type === 'chatted' && e.player === seat && e.text.startsWith(MISSING_PREFIX) ? [`${log[i]!.turn} ${e.text}`] : []));
        expect(missing.length).toBeLessThanOrEqual(10);
        expect(new Set(missing).size).toBe(missing.length);
      }
      expect(events.some((e) => e.type === 'duelEnded')).toBe(true);
    }

    // The prompt: rules and decks cached, then the log one entry per block with the cache mark on the last.
    const content = requests.at(-1)!.messages[0]!.content as Anthropic.TextBlockParam[];
    expect((requests.at(-1)!.system as Anthropic.TextBlockParam[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(content[0]!.text).toContain("# The decks");
    expect(content[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(content.at(-2)!.cache_control).toEqual({ type: 'ephemeral' });
    expect(content.at(-1)!.text).toContain('# The board now');
    expect(requests.at(-1)!.thinking).toEqual({ type: 'disabled' });

    // Its calls count in the admin's cost list.
    const list = (await admin.json<AdminDuels>(`${h.baseUrl}/api/admin/duels`)).body;
    const first = await eventsOf(ids[0]!);
    const count = (type: DuelEvent['type']) => first.filter((e) => e.type === type).length;
    expect(list.duels.find((d) => d.id === ids[0])).toMatchObject({ aiCalls: count('aiDecided'), judgeCalls: 0, appeals: count('appealed') });
  }, 120_000);
});
