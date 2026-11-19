// Running duels. The server is the only authority: it holds each duel's event log, turns player
// intents into events with the engine, stores them, and pushes each seat its own filtered view.
//
// Live duels are kept in memory by this process and rebuilt from the log on first use, so the site
// must run as a single server process.

import { randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, or } from 'drizzle-orm';
import {
  cardOf,
  decide,
  entryFor,
  evolve,
  logFor,
  replay,
  startDuel,
  viewFor,
  visibleTo,
  type ChainLink,
  type DuelEvent,
  type DuelState,
  type DuelUpdate,
  type Intent,
  type JudgingView,
  type Seat,
} from '@yugioh/engine';
import type { DuelSummary } from '@yugioh/shared';
import { loadCards } from './cards.ts';
import type { Db, Tx } from './db/client.ts';
import { decks, matchEvents, matches, users } from './db/schema.ts';
import { appeal } from './judge/appeal.ts';
import { judge, type ModelCall, type Question } from './judge/judge.ts';
import { loadSheets } from './sheets.ts';

type MatchRow = typeof matches.$inferSelect;

/** Who takes the empty seat. Called inside the join transaction, so a guest created here is rolled back with it. */
export type SeatClaim = (tx: Tx) => Promise<{ key: string; name: string }>;

interface LiveDuel {
  id: string;
  events: DuelEvent[];
  state: DuelState;
  listeners: Set<{ seat: Seat; send: (update: DuelUpdate) => void }>;
  /** Changes to one duel happen one at a time, in arrival order: intents, judge calls, appeal verdicts. */
  queue: Promise<unknown>;
  /** The judge call in progress, if any. Nothing it does is in `events` until it finishes. */
  judging: Judging | null;
  /** Contests being reviewed, as `seq:seat`, so the same one isn't sent twice. */
  appealing: Set<string>;
}

interface Judging {
  stage: 'activation' | 'resolution';
  link: ChainLink;
  /** `picks` holds what the player sends for each of `cards`: its ID, or a one-off key for a face-down card. */
  question: (Question & { id: string; picks: string[]; answer: (picks: string[]) => void }) | null;
}

export type ActResult = { ok: true } | { ok: false; status: number; error: string };

/** The models the duel server calls. Null when no Anthropic API key is set: effects can't be activated then. */
export interface Ai {
  judge: ModelCall | null;
  appeal: ModelCall | null;
  /** Judge calls allowed per duel (an activation and its resolution are two). */
  judgeCalls: number;
  /** Contests allowed per duel, for both players together. */
  appeals: number;
}

/** A random float in [0, 1) from the system's secure generator, for shuffles and the coin toss. */
const secureRandom = () => randomInt(2 ** 47) / 2 ** 47;

export class Duels {
  private live = new Map<string, Promise<LiveDuel>>();
  private db: Db;
  private ai: Ai;
  constructor(db: Db, ai: Ai) {
    this.db = db;
    this.ai = ai;
  }

  async create(userId: number, seatKey: string, deckId: number): Promise<string | null> {
    if (!(await this.db.query.decks.findFirst({ where: eq(decks.id, deckId) }))) return null;
    const id = randomBytes(12).toString('base64url');
    await this.db.insert(matches).values({ id, createdBy: userId, seat0: seatKey, deck0: deckId });
    return id;
  }

  async find(id: string): Promise<MatchRow | undefined> {
    return this.db.query.matches.findFirst({ where: eq(matches.id, id) });
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
    const [creator] = await this.db.select({ username: users.username }).from(users).where(eq(users.id, row.createdBy));
    const deckName = async (id: number | null) =>
      id === null ? null : ((await this.db.query.decks.findFirst({ where: eq(decks.id, id) }))?.name ?? null);
    return {
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      createdBy: creator?.username ?? 'a player',
      decks: [(await deckName(row.deck0)) ?? '', await deckName(row.deck1)],
      yourSeat: seatKey === null ? null : seatKey === row.seat0 ? 0 : seatKey === row.seat1 ? 1 : null,
      canJoin: canJoin && row.status === 'waiting' && seatKey !== row.seat0,
    };
  }

  /**
   * Takes the empty seat and deals the opening hands. Returns false, having changed nothing, if the
   * seat was already taken or the claimant is the challenger.
   */
  async join(id: string, deckId: number, challengerName: string, claim: SeatClaim): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [waiting] = await tx
        .select()
        .from(matches)
        .where(and(eq(matches.id, id), eq(matches.status, 'waiting')))
        .for('update');
      if (!waiting) return false;
      const player = await claim(tx);
      if (player.key === waiting.seat0) return false;
      const [row] = await tx
        .update(matches)
        .set({ seat1: player.key, deck1: deckId, status: 'active' })
        .where(eq(matches.id, id))
        .returning();
      if (!row) return false;
      const [deck0, deck1] = await Promise.all(
        [row.deck0, deckId].map((d) => tx.query.decks.findFirst({ where: eq(decks.id, d) })),
      );
      if (!deck0 || !deck1) throw new Error('Deck not found');
      const cards = await loadCards(this.db, [...deck0.main, ...deck0.extra, ...deck1.main, ...deck1.extra]);
      const events = startDuel(
        {
          players: [
            { name: challengerName, main: deck0.main, extra: deck0.extra },
            { name: player.name, main: deck1.main, extra: deck1.extra },
          ],
          cards,
          sheets: await loadSheets(cards),
        },
        secureRandom,
      );
      await tx.insert(matchEvents).values(events.map((event, seq) => ({ matchId: id, seq, event })));
      return true;
    });
  }

  private load(id: string): Promise<LiveDuel> {
    let duel = this.live.get(id);
    if (!duel) {
      duel = (async () => {
        const row = await this.find(id);
        if (!row || row.status === 'waiting') throw new Error(`Duel ${id} has not started`);
        const rows = await this.db.select().from(matchEvents).where(eq(matchEvents.matchId, id)).orderBy(matchEvents.seq);
        const events = rows.map((r) => r.event as DuelEvent);
        const live: LiveDuel = { id, events, state: replay(events), listeners: new Set(), queue: Promise.resolve(), judging: null, appealing: new Set() };
        // An effect that was activated but not resolved when the server stopped resolves now.
        if (live.state.chain.length > 0) void this.enqueue(live, () => this.resolveChain(live));
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

  /** Which seat a player holds, if any. Read from the database each time, since seats can change hands (see adoptGuest). */
  async seatOf(id: string, seatKey: string): Promise<Seat | null> {
    const row = await this.find(id);
    return row?.seat0 === seatKey ? 0 : row?.seat1 === seatKey ? 1 : null;
  }

  /**
   * Handles a player's intent. An activation answers as soon as code accepts it; the judge then checks and resolves
   * it in the duel's queue, and players follow along through their streams.
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
          return answer({ ok: true });
        }
        if (!this.ai.judge) return answer({ ok: false, status: 503, error: "Card effects need the judge, and it isn't set up on this server." });
        if (judgeCallsMade(duel.events) + 2 > this.ai.judgeCalls) {
          return answer({ ok: false, status: 429, error: 'This duel has used all its judge calls.' });
        }
        answer({ ok: true });
        await this.activate(duel, decision.events);
      }).catch(() => answer({ ok: false, status: 500, error: 'Something went wrong.' }));
    });
  }

  /** Checks an activation with the judge, then resolves it. `events` are the intent and the activation, not yet committed. */
  private async activate(duel: LiveDuel, events: DuelEvent[]) {
    const [intent, ...activation] = events;
    const scratch = activation.reduce(evolve, duel.state);
    const { record, events: costs } = await this.runJudge(duel, 'activation', scratch, scratch.chain.at(-1)!);
    const judged: DuelEvent = { type: 'judged', record };
    await this.commit(duel, record.legal ? [intent!, judged, ...activation, ...costs] : [intent!, judged]);
    if (record.legal) await this.resolveChain(duel);
  }

  /** Resolves the chain's links, last first. */
  private async resolveChain(duel: LiveDuel) {
    while (duel.state.chain.length > 0 && !duel.state.result) {
      const link = duel.state.chain.at(-1)!;
      const { record, events } = await this.runJudge(duel, 'resolution', duel.state, link);
      await this.commit(duel, [{ type: 'judged', record }, ...events, { type: 'linkResolved' }]);
    }
  }

  private async runJudge(duel: LiveDuel, stage: 'activation' | 'resolution', state: DuelState, link: ChainLink) {
    duel.judging = { stage, link, question: null };
    this.broadcastJudging(duel);
    try {
      return await judge(
        { stage, state, link },
        {
          model: this.ai.judge!,
          random: secureRandom,
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
    const options = new Set([...q.picks, ...q.choices]);
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
    const event = duel.events[seq];
    const seen = event?.type === 'judged' && logFor(duel.events.slice(0, seq + 1), seat).at(-1)?.seq === seq;
    if (!seen) return { ok: false, status: 404, error: 'There is no such ruling.' };
    const key = `${seq}:${seat}`;
    const appeals = duel.events.filter((e) => e.type === 'appealed');
    if (duel.appealing.has(key) || appeals.some((e) => e.appeal.judged === seq && e.appeal.by === seat)) {
      return { ok: false, status: 409, error: 'You already contested this ruling.' };
    }
    if (appeals.length + duel.appealing.size >= this.ai.appeals) return { ok: false, status: 429, error: 'This duel has used all its appeals.' };
    duel.appealing.add(key);
    const input = { before: replay(duel.events.slice(0, seq)), now: duel.state, record: event.record, judged: seq, by: seat, note };
    void appeal(input, this.ai.appeal)
      .then((record) => this.enqueue(duel, () => this.commit(duel, [{ type: 'appealed', appeal: record }])))
      .catch((error: unknown) => console.error(`Appeal in duel ${duel.id} failed:`, error))
      .finally(() => duel.appealing.delete(key));
    return { ok: true };
  }

  /** Stores events, applies them, and sends each seat the steps. */
  private async commit(duel: LiveDuel, events: DuelEvent[]) {
    const first = duel.events.length;
    await this.db.transaction(async (tx) => {
      await tx.insert(matchEvents).values(events.map((event, i) => ({ matchId: duel.id, seq: first + i, event })));
      if (events.some((e) => e.type === 'duelEnded')) {
        await tx.update(matches).set({ status: 'finished', finishedAt: new Date() }).where(eq(matches.id, duel.id));
      }
    });
    const before = duel.state;
    duel.events.push(...events);
    duel.state = events.reduce(evolve, duel.state);
    this.broadcast(before, events, first, duel);
  }

  /** Sends the seat the whole duel now, and the steps of every change after. Returns the unsubscribe function. */
  async watch(id: string, seat: Seat, send: (update: DuelUpdate) => void): Promise<() => void> {
    const duel = await this.load(id);
    const listener = { seat, send };
    duel.listeners.add(listener);
    send({ type: 'sync', view: viewFor(duel.state, seat), log: logFor(duel.events, seat), judging: judgingFor(duel, seat) });
    return () => duel.listeners.delete(listener);
  }

  /**
   * Sends each seat one step per visible new event: the log entry and the board right after it, so the client
   * can animate events in order. Only the last step offers actions, since nobody may act mid-sequence.
   */
  private broadcast(before: DuelState, events: DuelEvent[], first: number, duel: LiveDuel) {
    const updateFor = (seat: Seat): Extract<DuelUpdate, { type: 'steps' }> => {
      let state = before;
      const steps = events.flatMap((event, i) => {
        state = evolve(state, event);
        const entry = entryFor(state, event, first + i, state.turn, seat);
        return entry ? [{ entry, view: viewFor(state, seat) }] : [];
      });
      for (const step of steps.slice(0, -1)) step.view.actions = [];
      return { type: 'steps', steps };
    };
    const updates = [updateFor(0), updateFor(1)] as const;
    for (const l of duel.listeners) if (updates[l.seat].steps.length > 0) l.send(updates[l.seat]);
  }

  private broadcastJudging(duel: LiveDuel) {
    for (const l of duel.listeners) l.send({ type: 'judging', judging: judgingFor(duel, l.seat) });
  }
}

const judgeCallsMade = (events: DuelEvent[]) => events.filter((e) => e.type === 'judged').length;

/** The judge's progress as one seat may see it. */
function judgingFor(duel: LiveDuel, seat: Seat): JudgingView | null {
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
            min: q.min,
            max: q.max,
          }
        : null,
  };
}
