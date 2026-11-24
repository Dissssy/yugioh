// Running duels. The server is the only authority: it holds each duel's event log, turns player
// intents into events with the engine, stores them, and pushes each seat its own filtered view.
//
// Live duels are kept in memory by this process and rebuilt from the log on first use, so the site
// must run as a single server process.

import { randomBytes, randomInt } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, or } from 'drizzle-orm';
import {
  cardOf,
  decide,
  isProcedure,
  procedureDone,
  scriptOf,
  entryFor,
  evolve,
  logFor,
  nextStep,
  replay,
  replaySteps,
  startDuel,
  triggerEvent,
  viewFor,
  visibleTo,
  zonePick,
  type ChainLink,
  type AiRecord,
  type AppealRecord,
  type DuelEvent,
  type SeatStep,
  type DuelState,
  type DuelUpdate,
  type EffectSheet,
  type Intent,
  type JudgeRecord,
  type JudgingView,
  type Seat,
  type Sight,
} from '@yugioh/engine';
import { NO_BANLIST, type Banlist, type DuelDeck, type DuelSummary, type Replay } from '@yugioh/shared';
import { loadCards } from './cards.ts';
import type { Db, Tx } from './db/client.ts';
import { matchEvents, matches, sheetReports } from './db/schema.ts';
import { appeal } from './judge/appeal.ts';
import { askJudge, escalate } from './judge/ask.ts';
import type { JudgeOutcome, ModelCall, Question } from './judge/judge.ts';
import { calledModel, NO_JUDGE, rule, SCRIPT } from './judge/script.ts';
import { flagScripts, loadSheets } from './sheets.ts';
import { aiKey, isAiKey } from './viewer.ts';

type MatchRow = typeof matches.$inferSelect;

/** Who takes the empty seat. Called inside the join transaction, so a guest created here is rolled back with it. */
export type SeatClaim = (tx: Tx) => Promise<{ key: string; name: string }>;

interface LiveDuel {
  id: string;
  events: DuelEvent[];
  state: DuelState;
  listeners: Set<Listener>;
  /** Changes to one duel happen one at a time, in arrival order: intents, judge calls, appeal verdicts. */
  queue: Promise<unknown>;
  /** Writes to the log, one at a time. Chat goes straight here, so players can talk while the judge works. */
  writes: Promise<unknown>;
  /** The judge call in progress, if any. Nothing it does is in `events` until it finishes. */
  judging: Judging | null;
  /** Contests being reviewed, as `seq:seat`, so the same one isn't sent twice. */
  appealing: Set<string>;
  /** Seats whose question to the judge is being answered: one at a time each. */
  asking: Set<Seat>;
  /** Questions (their `asked` seq) being escalated. */
  escalating: Set<number>;
  /** A pass the server will make for a player with nothing to activate, once the response floor has passed. */
  autoPass: ReturnType<typeof setTimeout> | null;
}

/** Someone following a duel live: a player (`sight` is their seat) or a spectator (`none`), with `seat` at the bottom. */
interface Listener {
  seat: Seat;
  sight: Sight;
  send: (update: DuelUpdate) => void;
}

interface Judging {
  stage: 'activation' | 'resolution';
  link: ChainLink;
  /** `picks` holds what the player sends for each of `cards`: its ID, or a one-off key for a face-down card. */
  question: (Question & { id: string; picks: string[]; answer: (picks: string[]) => void }) | null;
}

type Refusal = { ok: false; status: number; error: string };
export type ActResult = { ok: true } | Refusal;

/** Whether the duel has started: from then on its events are the duel, and decks can't change. */
export const started = (row: Pick<MatchRow, 'status'>) => row.status === 'active' || row.status === 'finished';

const deckOf = (row: MatchRow, seat: Seat) => (seat === 0 ? row.deck0 : row.deck1);
const seatIn = (row: MatchRow, seatKey: string): Seat | null => (seatKey === row.seat0 ? 0 : seatKey === row.seat1 ? 1 : null);

/** The models the duel server calls. Null when no Anthropic API key is set: effects can't be activated then. */
export interface Ai {
  judge: ModelCall | null;
  appeal: ModelCall | null;
  /** Judge calls allowed per duel (an activation and its resolution are two). */
  judgeCalls: number;
  /** Contests allowed per duel, for both players together. Escalated questions count too. */
  appeals: number;
  /** Questions to the judge each player may ask per duel (docs/ask-the-judge.md). */
  questions: number;
  /** The AI opponent's model, or null when the server has no API key (docs/ai-opponent.md). */
  opponent: OpponentModel | null;
}

export interface OpponentModel {
  call: ModelCall;
  /** Which model it plays with (AI_OPPONENT_MODEL). */
  model: string;
  /** Model calls allowed per duel (AI_CALLS_PER_DUEL). */
  calls: number;
  /** The least time between two of its moves, so players can follow the board. */
  paceMs: number;
}

/** A random float in [0, 1) from the system's secure generator, for shuffles and response timing. */
const secureRandom = () => randomInt(2 ** 47) / 2 ** 47;

export class Duels {
  /** Called once for each AI seat of a duel that is loaded and still going, so the AI opponent can start playing it. */
  onAiSeat: ((id: string, seat: Seat) => void) | null = null;
  private live = new Map<string, Promise<LiveDuel>>();
  private db: Db;
  private ai: Ai;
  private random: () => number;
  private responseFloorMs: number;
  /**
   * `random` shuffles and times auto-passes; tests pass a seeded one so every run deals the same hands.
   * `responseFloorMs` is the least time a response window stays open (see Config).
   */
  constructor(db: Db, ai: Ai, random: () => number = secureRandom, responseFloorMs = 1000) {
    this.db = db;
    this.ai = ai;
    this.random = random;
    this.responseFloorMs = responseFloorMs;
  }

  /** A challenge: the challenger takes seat 0 and waits for an opponent. Decks are chosen once both have sat down. */
  async create(userId: number, seatKey: string, name: string, banlist: Banlist, premadeOnly: boolean): Promise<string> {
    const id = randomBytes(12).toString('base64url');
    await this.db.insert(matches).values({ id, createdBy: userId, seat0: seatKey, name0: name, banlist, premadeOnly });
    return id;
  }

  /** A duel against the AI opponent: the player takes seat 0 and the AI seat 1, both decks are given, and it starts at once. */
  async createAgainstAi(userId: number, seatKey: string, name: string, deck: DuelDeck, aiDeck: DuelDeck): Promise<string> {
    const id = randomBytes(12).toString('base64url');
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(matches)
        .values({ id, createdBy: userId, seat0: seatKey, name0: name, seat1: aiKey('claude'), name1: 'Claude', banlist: NO_BANLIST, deck0: deck, deck1: aiDeck, status: 'preparing' })
        .returning();
      await this.start(tx, row!);
    });
    return id;
  }

  async find(id: string): Promise<MatchRow | undefined> {
    return this.db.query.matches.findFirst({ where: eq(matches.id, id) });
  }

  /** The latest duels of everyone, for the admin. */
  async recent(): Promise<MatchRow[]> {
    return this.db.query.matches.findMany({ orderBy: [desc(matches.createdAt)], limit: 50 });
  }

  /** Duels the player sits in. */
  async list(seatKey: string): Promise<MatchRow[]> {
    return this.db.query.matches.findMany({
      where: or(eq(matches.seat0, seatKey), eq(matches.seat1, seatKey)),
      orderBy: [desc(matches.createdAt)],
      limit: 30,
    });
  }

  async summarize(row: MatchRow, seatKey: string | null, canJoin: boolean): Promise<DuelSummary> {
    const yourSeat = seatKey === null ? null : seatKey === row.seat0 ? 0 : seatKey === row.seat1 ? 1 : null;
    // Each player sees only their own deck until the duel starts.
    const deckName = (seat: Seat) => (started(row) || yourSeat === seat ? (deckOf(row, seat)?.name ?? null) : null);
    return {
      id: row.id,
      status: row.status,
      banlist: row.banlist.name,
      premadeOnly: row.premadeOnly,
      createdAt: row.createdAt.toISOString(),
      finishedAt: row.finishedAt?.toISOString() ?? null,
      players: [
        { name: row.name0, deck: deckName(0), ready: row.ready0 },
        row.name1 === null ? null : { name: row.name1, deck: deckName(1), ready: row.ready1 },
      ],
      result: row.result,
      yourSeat,
      canJoin: canJoin && row.status === 'waiting' && seatKey !== row.seat0,
    };
  }

  /**
   * Takes the empty seat; both players then choose their decks. Returns false, having changed nothing, if the seat was
   * already taken or the claimant is the challenger.
   */
  async join(id: string, claim: SeatClaim): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [waiting] = await tx
        .select()
        .from(matches)
        .where(and(eq(matches.id, id), eq(matches.status, 'waiting')))
        .for('update');
      if (!waiting) return false;
      const player = await claim(tx);
      if (player.key === waiting.seat0) return false;
      await tx.update(matches).set({ seat1: player.key, name1: player.name, status: 'preparing' }).where(eq(matches.id, id));
      return true;
    });
  }

  /**
   * Replaces the player's copy of their deck in the pre-duel stage, which also takes back their Ready. `next` gets the
   * duel and the copy so far, and gives the new copy or why it can't be.
   */
  async setDeck(id: string, seatKey: string, next: (row: MatchRow, current: DuelDeck | null) => DuelDeck | string): Promise<{ ok: true; deck: DuelDeck } | Refusal> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(matches).where(eq(matches.id, id)).for('update');
      const seat = row ? seatIn(row, seatKey) : null;
      if (!row || seat === null) return { ok: false, status: 403, error: "You're not playing in this duel." };
      if (row.status !== 'preparing') return { ok: false, status: 409, error: 'Decks can only be changed before the duel starts.' };
      const deck = next(row, deckOf(row, seat));
      if (typeof deck === 'string') return { ok: false, status: 422, error: deck };
      await tx
        .update(matches)
        .set(seat === 0 ? { deck0: deck, ready0: false } : { deck1: deck, ready1: false })
        .where(eq(matches.id, id));
      return { ok: true, deck };
    });
  }

  /**
   * Readies the player, or takes it back. A deck is ready only if `problems` finds nothing wrong with it under the
   * duel's banlist. Once both players are ready, the duel starts.
   */
  async ready(id: string, seatKey: string, ready: boolean, problems: (deck: DuelDeck, banlist: Banlist) => Promise<string[]>): Promise<ActResult> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(matches).where(eq(matches.id, id)).for('update');
      const seat = row ? seatIn(row, seatKey) : null;
      if (!row || seat === null) return { ok: false, status: 403, error: "You're not playing in this duel." };
      if (row.status !== 'preparing') return { ok: false, status: 409, error: 'The duel has already started.' };
      const deck = deckOf(row, seat);
      if (ready) {
        if (!deck) return { ok: false, status: 422, error: 'Choose a deck first.' };
        const wrong = await problems(deck, row.banlist);
        if (wrong.length > 0) return { ok: false, status: 422, error: wrong[0]! };
      }
      const [updated] = await tx
        .update(matches)
        .set(seat === 0 ? { ready0: ready } : { ready1: ready })
        .where(eq(matches.id, id))
        .returning();
      if (updated!.ready0 && updated!.ready1) await this.start(tx, updated!);
      return { ok: true };
    });
  }

  /** Shuffles both decks and starts the duel; rock-paper-scissors then decides who goes first. */
  private async start(tx: Tx, row: MatchRow) {
    const [deck0, deck1] = [row.deck0!, row.deck1!];
    const cards = await loadCards(this.db, [...deck0.main, ...deck0.extra, ...deck1.main, ...deck1.extra]);
    const events = startDuel(
      {
        players: [
          { name: row.name0, main: deck0.main, extra: deck0.extra },
          { name: row.name1!, main: deck1.main, extra: deck1.extra },
        ],
        cards,
        sheets: await loadSheets(this.db, cards),
      },
      this.random,
    );
    await tx.insert(matchEvents).values(events.map((event, seq) => ({ matchId: row.id, seq, event })));
    await tx.update(matches).set({ status: 'active' }).where(eq(matches.id, row.id));
  }

  private load(id: string): Promise<LiveDuel> {
    let duel = this.live.get(id);
    if (!duel) {
      duel = (async () => {
        const row = await this.find(id);
        if (!row || !started(row)) throw new Error(`Duel ${id} has not started`);
        const rows = await this.db.select().from(matchEvents).where(eq(matchEvents.matchId, id)).orderBy(matchEvents.seq);
        const events = rows.map((r) => r.event as DuelEvent);
        const live: LiveDuel = {
          id,
          events,
          state: replay(events),
          listeners: new Set(),
          queue: Promise.resolve(),
          writes: Promise.resolve(),
          judging: null,
          appealing: new Set(),
          asking: new Set(),
          escalating: new Set(),
          autoPass: null,
        };
        // Sheets that changed while the duel wasn't loaded (a report, a fix) apply from here on.
        if (!live.state.result) {
          const now = await loadSheets(this.db, live.state.cards);
          const changed = Object.keys(live.state.cards)
            .map(Number)
            // Compared as values: Postgres stores JSON with its keys in its own order, so the text of an unchanged sheet differs.
            .filter((code) => !isDeepStrictEqual(now[code] ?? null, live.state.sheets[code] ?? null));
          if (changed.length) await this.write(live, changed.map((code) => ({ type: 'sheetUpdated', code, sheet: now[code] ?? null })));
        }
        // Whatever the duel was doing when the server stopped (resolving a chain, waiting out a window) carries on.
        void this.enqueue(live, () => this.advance(live));
        if (!live.state.result) {
          for (const seat of [0, 1] as const) if (isAiKey(seat === 0 ? row.seat0 : row.seat1)) queueMicrotask(() => this.onAiSeat?.(id, seat));
        }
        return live;
      })();
      duel.catch(() => this.live.delete(id));
      this.live.set(id, duel);
    }
    return duel;
  }

  /** Runs `task` after everything queued for the duel. A failing task is logged and doesn't block the queue. */
  private enqueue<T>(duel: LiveDuel, task: () => Promise<T>): Promise<T> {
    const run = duel.queue.then(task);
    duel.queue = run.catch((error: unknown) => console.error(`Duel ${duel.id}:`, error));
    return run;
  }

  /**
   * A finished duel as one seat saw it, or with every card face up, step by step (docs/next-steps.md, Replays).
   * Only `questionsOf`'s questions to the judge show: a player's own, every one (`both`, an admin) or none (null).
   */
  async replay(id: string, from: Seat | 'both', questionsOf: Seat | 'both' | null): Promise<Replay> {
    const rows = await this.db.select().from(matchEvents).where(eq(matchEvents.matchId, id)).orderBy(matchEvents.seq);
    return { from, steps: replaySteps(rows.map((r) => r.event as DuelEvent), from, questionsOf) };
  }

  /** Which seat a player holds, if any. Read from the database each time, since seats can change hands (see adoptGuest). */
  async seatOf(id: string, seatKey: string): Promise<Seat | null> {
    const row = await this.find(id);
    return row ? seatIn(row, seatKey) : null;
  }

  /**
   * Handles a player's intent. An activation answers as soon as code accepts it; the judge (or the effect's script)
   * then checks and resolves it in the duel's queue, and players follow along through their streams.
   */
  async act(id: string, seatKey: string, intent: Intent): Promise<ActResult> {
    const duel = await this.load(id);
    return new Promise<ActResult>((answer) => {
      void this.enqueue(duel, async () => {
        const seat = await this.seatOf(id, seatKey);
        if (seat === null) return answer({ ok: false, status: 403, error: "You're not playing in this duel." });
        const decision = decide(duel.state, seat, intent);
        if (!decision.ok) return answer({ ok: false, status: 422, error: decision.error });
        if (intent.type !== 'activate') {
          await this.commit(duel, decision.events);
          answer({ ok: true });
          // Both players accepted the rewind: the board goes back to before the overturned ruling.
          const offer = duel.state.rollback;
          if (offer?.accepted.length === 2) {
            const { instances: _i, cards: _c, sheets: _s, ...board } = replay(duel.events.slice(0, offer.to));
            await this.commit(duel, [{ type: 'rolledBack', to: offer.to, board }]);
          }
          return this.advance(duel);
        }
        const blocked = this.judgeBlocked(duel, intent.card, intent.effect);
        if (blocked) return answer(blocked);
        answer({ ok: true });
        const [intentEvent, ...activation] = decision.events;
        if (isProcedure(duel.state, intent.card, intent.effect)) await this.useProcedure(duel, intentEvent!, activation[0]!);
        else await this.activate(duel, [intentEvent!], activation);
        await this.advance(duel);
      }).catch(() => answer({ ok: false, status: 500, error: 'Something went wrong.' }));
    });
  }

  /** Why an effect can't go to the judge now (no API key, or the duel's judge calls are used up), or null. A scripted effect needs neither. */
  private judgeBlocked(duel: LiveDuel, card: string, effect: number): Extract<ActResult, { ok: false }> | null {
    if (scriptOf(duel.state, card, effect)) return null;
    if (!this.ai.judge) return { ok: false, status: 503, error: "This card's effect needs the judge, and it isn't set up on this server." };
    if (judgeCallsMade(duel.events) + 2 > this.ai.judgeCalls) return { ok: false, status: 429, error: 'This duel has used all its judge calls.' };
    return null;
  }

  /**
   * Checks an activation with the judge or the effect's script, and commits it if legal. `before` (the intent, if a
   * player asked) is committed either way; `activation` (the card's activation) only if it is legal.
   */
  private async activate(duel: LiveDuel, before: DuelEvent[], activation: DuelEvent[]) {
    const scratch = activation.reduce(evolve, duel.state);
    const link = scratch.chain.at(-1)!;
    const overturned = duel.state.rulings.find((r) => r.legal && r.player === link.player && r.card === link.card && r.effect === link.effect);
    await this.runJudge(duel, 'activation', scratch, link, overturned?.summary ?? null, ({ record, events: costs }) => {
      const judged: DuelEvent = { type: 'judged', record };
      return record.legal ? [...before, judged, ...activation, ...costs] : [...before, judged];
    });
  }

  /**
   * Runs a Summoning procedure's script (its cost, then the Summon) and commits it if it worked, with the checkpoint
   * for the Summon. It never goes on the chain.
   */
  private async useProcedure(duel: LiveDuel, intent: DuelEvent, used: DuelEvent) {
    if (used.type !== 'procedureUsed') throw new Error('Expected a procedureUsed event');
    const link: ChainLink = { player: used.player, card: used.card, effect: used.effect, targets: [], choice: null, cause: null, negated: false, setAgain: false, taxed: false };
    const overturned = duel.state.rulings.find((r) => r.legal && r.player === link.player && r.card === link.card && r.effect === link.effect);
    await this.runJudge(duel, 'activation', evolve(duel.state, used), link, overturned?.summary ?? null, ({ record, events }) => {
      const judged: DuelEvent = { type: 'judged', record };
      if (!record.legal) return [intent, judged];
      const done = [judged, used, ...events];
      return [intent, ...done, procedureDone(done.reduce(evolve, duel.state), used.card)];
    });
  }

  /**
   * Moves the duel on until it waits for a player: commits the steps code takes by itself, puts mandatory triggers on
   * the chain, resolves chains, and passes for a player who has nothing to activate (after the response floor, so
   * the speed of a pass reveals nothing).
   */
  private async advance(duel: LiveDuel) {
    for (;;) {
      const next = nextStep(duel.state);
      if (!next) return;
      if (next.kind === 'events') {
        await this.commit(duel, next.events);
      } else if (next.kind === 'trigger') {
        const { card, effect } = next.trigger;
        const blocked = this.judgeBlocked(duel, card, effect);
        if (blocked) await this.commit(duel, [{ type: 'judged', record: notRuled(duel.state, 'activation', next.trigger.player, card, effect, blocked.error) }]);
        else await this.activate(duel, [], triggerEvent(next.trigger));
      } else if (next.kind === 'resolve') {
        const link = duel.state.chain.at(-1)!;
        // After a rollback, the resolution it undid is ruled again as the appeal said.
        const bound = duel.state.binding;
        const ruling = bound && bound.card === link.card && bound.effect === link.effect ? bound.ruling : null;
        // An activation reserved its resolution's judge call; only a missing API key (after a restart) stops it.
        const resolved = ({ record, events }: JudgeOutcome): DuelEvent[] => [{ type: 'judged', record }, ...events, { type: 'linkResolved' }];
        if (!scriptOf(duel.state, link.card, link.effect) && !this.ai.judge) {
          await this.commit(duel, resolved({ record: notRuled(duel.state, 'resolution', link.player, link.card, link.effect, "The judge isn't set up on this server."), events: [] }));
        } else {
          await this.runJudge(duel, 'resolution', duel.state, link, ruling, resolved);
        }
      } else {
        if (next.autoPass) this.passLater(duel, next.player, next.floor);
        return;
      }
    }
  }

  /** Passes for a player with nothing to activate, after the response floor unless `floor` is false. */
  private passLater(duel: LiveDuel, player: Seat, floor: boolean) {
    if (duel.autoPass) clearTimeout(duel.autoPass);
    const step = duel.state.step;
    const delay = floor ? this.responseFloorMs * (1 + this.random() / 2) : 0;
    duel.autoPass = setTimeout(() => {
      duel.autoPass = null;
      void this.enqueue(duel, async () => {
        // Anything that moved the duel on since (an activation) makes this pass stale.
        if (duel.state.step !== step) return;
        await this.commit(duel, [{ type: 'passed', player }]);
        await this.advance(duel);
      });
    }, delay);
  }

  /**
   * Rules on a link and commits `toEvents` of the ruling. The judging banner stays up until the commit, so no seat is
   * shown the board from before the ruling without it, and offered moves on that stale board.
   */
  private async runJudge(duel: LiveDuel, stage: 'activation' | 'resolution', state: DuelState, link: ChainLink, appealRuling: string | null, toEvents: (ruled: JudgeOutcome) => DuelEvent[]) {
    duel.judging = { stage, link, question: null };
    this.broadcastJudging(duel);
    try {
      const ruled = await rule(
        { stage, state, link, appealRuling },
        {
          model: this.ai.judge,
          random: this.random,
          ask: (question) =>
            new Promise<string[]>((answer) => {
              const picks = question.cards.map((c) => (c.hidden ? randomBytes(6).toString('base64url') : c.id));
              duel.judging!.question = { ...question, id: randomBytes(6).toString('base64url'), picks, answer };
              this.broadcastJudging(duel);
            }).finally(() => {
              duel.judging!.question = null;
              this.broadcastJudging(duel);
            }),
        },
      );
      await this.commit(duel, toEvents(ruled));
    } finally {
      duel.judging = null;
      this.broadcastJudging(duel);
    }
  }

  /** A player's answer to the judge's question. */
  async answer(id: string, seatKey: string, promptId: string, picks: string[]): Promise<ActResult> {
    const duel = await this.load(id);
    const seat = await this.seatOf(id, seatKey);
    if (seat === null) return { ok: false, status: 403, error: "You're not playing in this duel." };
    const q = duel.judging?.question;
    if (!q || q.id !== promptId || q.player !== seat) return { ok: false, status: 409, error: 'That question is no longer open.' };
    const options = new Set([...q.picks, ...q.choices, ...q.zones.map(zonePick)]);
    if (new Set(picks).size !== picks.length || !picks.every((p) => options.has(p))) return { ok: false, status: 422, error: 'Pick from the options given.' };
    if (picks.length < q.min || picks.length > q.max) {
      return { ok: false, status: 422, error: q.min === q.max ? `Pick ${q.min}.` : `Pick ${q.min} to ${q.max}.` };
    }
    q.answer(picks.map((p) => q.cards[q.picks.indexOf(p)]?.id ?? p));
    return { ok: true };
  }

  /**
   * Contests a judge decision: a stronger model reviews it, and its verdict joins the log. Answers once the contest is
   * accepted; the verdict follows through the players' streams.
   */
  async contest(id: string, seatKey: string, seq: number, note: string): Promise<ActResult> {
    const duel = await this.load(id);
    const seat = await this.seatOf(id, seatKey);
    if (seat === null) return { ok: false, status: 403, error: "You're not playing in this duel." };
    if (!this.ai.appeal) return { ok: false, status: 503, error: "Appeals need an Anthropic API key, and this server has none." };
    return this.startContest(duel, seat, seq, note, false);
  }

  /** Appeals used or under way: contests, and escalated questions that didn't become a contest (which counts itself). */
  private appealsUsed(duel: LiveDuel): number {
    const used = duel.events.filter((e) => e.type === 'appealed' || (e.type === 'escalated' && e.record.outcome !== 'ruling_wrong')).length;
    return used + duel.appealing.size + duel.escalating.size;
  }

  /** `escalated`: a contest an escalated question started, whose escalation already counted against the appeals. */
  private startContest(duel: LiveDuel, seat: Seat, seq: number, note: string, escalated: boolean): ActResult {
    const appealModel = this.ai.appeal!;
    const event = duel.events[seq];
    const seen = event?.type === 'judged' && logFor(duel.events.slice(0, seq + 1), seat).at(-1)?.seq === seq;
    if (!seen) return { ok: false, status: 404, error: 'There is no such ruling.' };
    if (duel.events.some((e, i) => e.type === 'rolledBack' && i > seq && e.to <= seq)) return { ok: false, status: 409, error: 'A rewind undid that ruling.' };
    const key = `${seq}:${seat}`;
    const appeals = duel.events.filter((e) => e.type === 'appealed');
    if (duel.appealing.has(key) || appeals.some((e) => e.appeal.judged === seq && e.appeal.by === seat)) {
      return { ok: false, status: 409, error: 'You already contested this ruling.' };
    }
    if (!escalated && this.appealsUsed(duel) >= this.ai.appeals) return { ok: false, status: 429, error: 'This duel has used all its appeals.' };
    duel.appealing.add(key);
    const input = { before: replay(duel.events.slice(0, seq)), now: duel.state, record: event.record, judged: seq, by: seat, note };
    void appeal(input, appealModel)
      .then(async (record) => {
        await this.enqueue(duel, () => this.commit(duel, [{ type: 'appealed', appeal: record }, ...this.rollbackOffer(duel, seq, record)]));
        // An overturned scripted ruling means the script is wrong: the judge takes the card over until it is fixed.
        if (record.verdict === 'overturned' && event.record.model === SCRIPT) {
          const code = cardOf(duel.state, event.record.card).code;
          await this.db.insert(sheetReports).values({ code, matchId: duel.id, seq, reporter: 'appeal', note: record.ruling });
          await this.sheetChanged(code, await flagScripts(this.db, code, `appeal overturned a scripted ruling: ${record.ruling}`));
        }
      })
      .catch((error: unknown) => console.error(`Appeal in duel ${duel.id} failed:`, error))
      .finally(() => duel.appealing.delete(key));
    return { ok: true };
  }

  /**
   * A player's question to the judge, answered from what their seat can see (docs/ask-the-judge.md). Answers once the
   * question is accepted; the answer arrives in that player's log only. The duel never waits for it.
   */
  async ask(id: string, seatKey: string, question: string, card: number | null): Promise<ActResult> {
    const duel = await this.load(id);
    const seat = await this.seatOf(id, seatKey);
    if (seat === null) return { ok: false, status: 403, error: "You're not playing in this duel." };
    if (!this.ai.judge) return { ok: false, status: 503, error: 'Questions need an Anthropic API key, and this server has none.' };
    const state = duel.state;
    if (duel.asking.has(seat)) return { ok: false, status: 409, error: 'Your last question is still being answered.' };
    // A question the judge failed to answer doesn't count.
    const asked = duel.events.filter((e) => e.type === 'asked' && e.record.player === seat && !e.record.error).length;
    if (asked >= this.ai.questions) return { ok: false, status: 429, error: `You can ask the judge up to ${this.ai.questions} questions per duel.` };
    const view = viewFor(state, seat);
    // The cards this player may know: their own Deck and Extra Deck, and every card they can see now.
    const codes = new Set([...view.deckList, ...Object.entries(state.instances).flatMap(([i, c]) => (visibleTo(state, i, seat) ? [c.code] : []))]);
    if (card !== null && !codes.has(card)) return { ok: false, status: 404, error: "There's no such card." };
    const cards = [...codes].map((code) => ({ card: state.cards[code]!, sheet: state.sheets[code] ?? null }));
    const input = { view, log: logFor(duel.events, seat), cards, question, card, state };
    duel.asking.add(seat);
    void askJudge(input, this.ai.judge)
      .then((record) => this.commit(duel, [{ type: 'asked', record }]))
      .catch((error: unknown) => console.error(`Question in duel ${duel.id} failed:`, error))
      .finally(() => duel.asking.delete(seat));
    return { ok: true };
  }

  /**
   * Escalates a player's question to the appeal model, which sees the whole board. Its finding joins the asker's log;
   * a wrong ruling is contested for them, a wrong card is reported (its scripts set aside, as a player's report does),
   * and a wrong rule in code is reported for the admin. It uses one of the duel's appeals.
   */
  async escalate(id: string, seatKey: string, seq: number, note: string): Promise<ActResult> {
    const duel = await this.load(id);
    const seat = await this.seatOf(id, seatKey);
    if (seat === null) return { ok: false, status: 403, error: "You're not playing in this duel." };
    if (!this.ai.appeal) return { ok: false, status: 503, error: 'Escalating needs an Anthropic API key, and this server has none.' };
    const event = duel.events[seq];
    if (event?.type !== 'asked' || event.record.player !== seat) return { ok: false, status: 404, error: 'There is no such question.' };
    if (duel.escalating.has(seq) || duel.events.some((e) => e.type === 'escalated' && e.record.asked === seq)) {
      return { ok: false, status: 409, error: 'You already escalated this question.' };
    }
    if (this.appealsUsed(duel) >= this.ai.appeals) return { ok: false, status: 429, error: 'This duel has used all its appeals.' };
    duel.escalating.add(seq);
    const input = { state: duel.state, events: duel.events, view: viewFor(duel.state, seat), asked: event.record, seq, note };
    void escalate(input, this.ai.appeal)
      .then(async (record) => {
        await this.commit(duel, [{ type: 'escalated', record }]);
        if (record.outcome === 'ruling_wrong') {
          const started = this.startContest(duel, seat, record.judged!, `Escalated question: ${record.ruling}`, true);
          if (!started.ok) console.log(`Duel ${duel.id}: an escalation found ruling #${record.judged} wrong, but it can't be contested: ${started.error}`);
        } else if (record.outcome === 'card_wrong') {
          await this.db.insert(sheetReports).values({ code: record.code!, matchId: duel.id, seq: duel.events.length, reporter: 'escalation', note: record.ruling });
          await this.sheetChanged(record.code!, await flagScripts(this.db, record.code!, `escalated question found the card wrong: ${record.ruling}`));
        } else if (record.outcome === 'engine_wrong') {
          await this.db.insert(sheetReports).values({ code: null, matchId: duel.id, seq: duel.events.length, reporter: 'escalation', note: record.ruling });
        }
      })
      .catch((error: unknown) => console.error(`Escalation in duel ${duel.id} failed:`, error))
      .finally(() => duel.escalating.delete(seq));
    return { ok: true };
  }

  /**
   * An overturned ruling that changed the board (an activation allowed, or a resolution) offers both players a rewind
   * to just before it: before the activation's intent, or the resolution. Not once the duel is over.
   */
  private rollbackOffer(duel: LiveDuel, seq: number, appeal: AppealRecord): DuelEvent[] {
    const d = appeal.decision;
    if (appeal.verdict !== 'overturned' || duel.state.result || (d.stage === 'activation' && !d.legal)) return [];
    const before = duel.events[seq - 1];
    const to = d.stage === 'activation' && before?.type === 'intent' && before.intent.type === 'activate' ? seq - 1 : seq;
    return [{ type: 'rollbackOffered', offer: { judged: seq, to, decision: d, ruling: appeal.ruling, explanation: appeal.explanation } }];
  }

  /**
   * A player's report that a card is ruled wrongly. It is kept for the admin with the board it was made on, and any
   * script on the card is set aside at once, here and in every other duel, so the judge rules on the card instead.
   */
  async report(id: string, seatKey: string, code: number, note: string): Promise<ActResult> {
    const duel = await this.load(id);
    const seat = await this.seatOf(id, seatKey);
    if (seat === null) return { ok: false, status: 403, error: "You're not playing in this duel." };
    const state = duel.state;
    const known = Object.entries(state.instances).some(([card, i]) => i.code === code && (i.owner === seat || visibleTo(state, card, seat)));
    if (!known) return { ok: false, status: 404, error: "There's no such card in this duel." };
    const mine = await this.db.$count(sheetReports, and(eq(sheetReports.matchId, id), eq(sheetReports.reporter, seatKey)));
    if (mine >= REPORTS_PER_SEAT) return { ok: false, status: 429, error: `You can report up to ${REPORTS_PER_SEAT} cards per duel.` };
    await this.db.insert(sheetReports).values({ code, matchId: id, seq: duel.events.length, reporter: seatKey, note });
    await this.sheetChanged(code, await flagScripts(this.db, code, `reported by a player: ${note}`));
    return { ok: true };
  }

  /** Applies a card's new sheet to every loaded duel that has the card and is still going. */
  async sheetChanged(code: number, sheet: EffectSheet | null) {
    if (!sheet) return;
    for (const loading of this.live.values()) {
      const duel = await loading.catch(() => null);
      if (!duel || duel.state.result || !duel.state.cards[code]) continue;
      void this.enqueue(duel, async () => {
        await this.commit(duel, [{ type: 'sheetUpdated', code, sheet }]);
        // Nobody sees the change in the log, but it can change what each player may do.
        for (const l of duel.listeners) l.send(syncFor(duel, l.seat, l.sight));
      });
    }
  }

  /** A player's chat message. It joins the log in order with everything else, even while the judge is working. */
  async chat(id: string, seatKey: string, text: string): Promise<ActResult> {
    const duel = await this.load(id);
    const seat = await this.seatOf(id, seatKey);
    if (seat === null) return { ok: false, status: 403, error: "You're not playing in this duel." };
    await this.commit(duel, [{ type: 'chatted', player: seat, text }]);
    return { ok: true };
  }

  /** Stores one of the AI opponent's model calls in the duel's log, where only the admin's full log shows it. */
  async recordAi(id: string, record: AiRecord) {
    await this.commit(await this.load(id), [{ type: 'aiDecided', record }]);
  }

  /** How many model calls the AI opponent in `seat` has made in a duel, and its latest note to itself. */
  async aiHistory(id: string, seat: Seat): Promise<{ calls: number; note: string }> {
    const records = (await this.load(id)).events.flatMap((e) => (e.type === 'aiDecided' && e.record.player === seat ? [e.record] : []));
    return { calls: records.length, note: records.at(-1)?.note ?? '' };
  }

  /** Stores events, applies them, and sends each seat the steps. Commits happen one at a time, in call order. */
  private commit(duel: LiveDuel, events: DuelEvent[]): Promise<void> {
    const run = duel.writes.then(() => this.write(duel, events));
    duel.writes = run.catch(() => {});
    return run;
  }

  private async write(duel: LiveDuel, events: DuelEvent[]) {
    const first = duel.events.length;
    const before = duel.state;
    const after = events.reduce(evolve, before);
    await this.db.transaction(async (tx) => {
      await tx.insert(matchEvents).values(events.map((event, i) => ({ matchId: duel.id, seq: first + i, event })));
      if (after.result && !before.result) {
        await tx
          .update(matches)
          .set({ status: 'finished', finishedAt: new Date(), result: { ...after.result, turn: after.turn } })
          .where(eq(matches.id, duel.id));
      }
    });
    duel.events.push(...events);
    duel.state = after;
    this.broadcast(before, events, first, duel);
  }

  /**
   * Sends the whole duel now, and the steps of every change after, with `seat` at the bottom: to its player, or with
   * `sight` none to a spectator, who sees only what both players can see. Returns the unsubscribe function.
   */
  async watch(id: string, seat: Seat, sight: Sight, send: (update: DuelUpdate) => void): Promise<() => void> {
    const duel = await this.load(id);
    const listener = { seat, sight, send };
    duel.listeners.add(listener);
    send(syncFor(duel, seat, sight));
    return () => duel.listeners.delete(listener);
  }

  /**
   * Sends each listener one step per visible new event: the log entry and the board right after it, so the client
   * can animate events in order. Only the last step offers actions, since nobody may act mid-sequence.
   */
  private broadcast(before: DuelState, events: DuelEvent[], first: number, duel: LiveDuel) {
    const updateFor = (seat: Seat, sight: Sight): Extract<DuelUpdate, { type: 'steps' }> => {
      let state = before;
      let lastSeen = false;
      const steps: SeatStep[] = events.flatMap((event, i) => {
        const prior = state;
        state = evolve(state, event);
        const entry = entryFor(prior, state, event, first + i, sight);
        lastSeen = entry !== null;
        return entry ? [{ entry, view: viewFor(state, seat, sight) }] : [];
      });
      // A change nobody sees in the log (a pass) still changes what each player may do.
      if (!lastSeen) steps.push({ entry: null, view: viewFor(state, seat, sight) });
      for (const step of steps.slice(0, -1)) step.view.actions = [];
      return { type: 'steps', steps };
    };
    // Worked out once for each way of looking at the duel, however many are watching it that way.
    const updates = new Map<string, Extract<DuelUpdate, { type: 'steps' }>>();
    for (const l of duel.listeners) {
      const key = `${l.seat}:${l.sight}`;
      const update = updates.get(key) ?? updateFor(l.seat, l.sight);
      updates.set(key, update);
      if (update.steps.length > 0) l.send(update);
    }
  }

  private broadcastJudging(duel: LiveDuel) {
    for (const l of duel.listeners) l.send({ type: 'judging', judging: judgingFor(duel, l.sight) });
  }
}

/** A record for an effect nobody could rule on: an activation is refused, an effect does nothing. */
function notRuled(state: DuelState, stage: 'activation' | 'resolution', player: Seat, card: string, effect: number, error: string): JudgeRecord {
  const name = cardOf(state, card).name;
  return {
    stage,
    player,
    card,
    effect,
    model: NO_JUDGE,
    promptVersion: '',
    stateHash: '',
    transcript: [],
    legal: stage === 'resolution',
    summary: stage === 'activation' ? `${name}'s effect needs the judge, which isn't available, so it wasn't activated.` : `The judge isn't available, so ${name}'s effect did nothing.`,
    ops: [],
    error,
    usage: [],
  };
}

/** Reports each player may make per duel. */
const REPORTS_PER_SEAT = 5;

const judgeCallsMade = (events: DuelEvent[]) => events.filter((e) => e.type === 'judged' && calledModel(e.record.model)).length;

/** The whole duel now, with `seat` at the bottom, as `sight` sees it. */
const syncFor = (duel: LiveDuel, seat: Seat, sight: Sight): DuelUpdate => ({
  type: 'sync',
  view: viewFor(duel.state, seat, sight),
  log: logFor(duel.events, sight),
  judging: judgingFor(duel, sight),
});

/** The judge's progress as a player (or a spectator, `none`) may see it. */
function judgingFor(duel: LiveDuel, sight: Sight): JudgingView | null {
  const seat = sight === 0 || sight === 1 ? sight : null;
  const j = duel.judging;
  if (!j) return null;
  const state = duel.state;
  const shown = (id: string) => ({ id, card: cardOf(state, id) });
  const q = j.question;
  return {
    stage: j.stage,
    player: j.link.player,
    // Until the activation is accepted, a card from the hand is still in the hand.
    card: j.link.player === seat || visibleTo(state, j.link.card, seat) ? shown(j.link.card) : { hidden: true },
    waitingOn: q?.player ?? null,
    prompt:
      q && q.player === seat
        ? {
            id: q.id,
            text: q.text,
            cards: q.cards.map((c, i) => ({ pick: q.picks[i]!, card: c.hidden ? { hidden: true as const } : shown(c.id), place: c.place, seat: c.seat, zone: c.zone })),
            choices: q.choices,
            zones: q.zones,
            min: q.min,
            max: q.max,
          }
        : null,
  };
}
