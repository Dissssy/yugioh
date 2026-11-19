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
  scriptOf,
  entryFor,
  evolve,
  logFor,
  nextStep,
  replay,
  startDuel,
  triggerEvent,
  viewFor,
  visibleTo,
  type ChainLink,
  type AppealRecord,
  type DuelEvent,
  type DuelState,
  type DuelUpdate,
  type EffectSheet,
  type Intent,
  type JudgeRecord,
  type JudgingView,
  type Seat,
} from '@yugioh/engine';
import type { DuelSummary } from '@yugioh/shared';
import { loadCards } from './cards.ts';
import type { Db, Tx } from './db/client.ts';
import { decks, matchEvents, matches, sheetReports, users } from './db/schema.ts';
import { appeal } from './judge/appeal.ts';
import type { ModelCall, Question } from './judge/judge.ts';
import { rule, SCRIPT } from './judge/script.ts';
import { flagScripts, loadSheets } from './sheets.ts';

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
  /** Writes to the log, one at a time. Chat goes straight here, so players can talk while the judge works. */
  writes: Promise<unknown>;
  /** The judge call in progress, if any. Nothing it does is in `events` until it finishes. */
  judging: Judging | null;
  /** Contests being reviewed, as `seq:seat`, so the same one isn't sent twice. */
  appealing: Set<string>;
  /** A pass the server will make for a player with nothing to activate, once the response floor has passed. */
  autoPass: ReturnType<typeof setTimeout> | null;
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

/** A random float in [0, 1) from the system's secure generator, for shuffles and response timing. */
const secureRandom = () => randomInt(2 ** 47) / 2 ** 47;

export class Duels {
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

  async create(userId: number, seatKey: string, deckId: number): Promise<string | null> {
    if (!(await this.db.query.decks.findFirst({ where: eq(decks.id, deckId) }))) return null;
    const id = randomBytes(12).toString('base64url');
    await this.db.insert(matches).values({ id, createdBy: userId, seat0: seatKey, deck0: deckId });
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
   * Takes the empty seat and shuffles the Decks; rock-paper-scissors then decides who goes first. Returns false, having changed nothing, if the
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
          sheets: await loadSheets(this.db, cards),
        },
        this.random,
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
        const live: LiveDuel = {
          id,
          events,
          state: replay(events),
          listeners: new Set(),
          queue: Promise.resolve(),
          writes: Promise.resolve(),
          judging: null,
          appealing: new Set(),
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
        await this.activate(duel, [intentEvent!], activation);
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
    const { record, events: costs } = await this.runJudge(duel, 'activation', scratch, link, overturned?.summary ?? null);
    const judged: DuelEvent = { type: 'judged', record };
    await this.commit(duel, record.legal ? [...before, judged, ...activation, ...costs] : [...before, judged]);
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
        const { record, events } =
          !scriptOf(duel.state, link.card, link.effect) && !this.ai.judge
            ? { record: notRuled(duel.state, 'resolution', link.player, link.card, link.effect, "The judge isn't set up on this server."), events: [] }
            : await this.runJudge(duel, 'resolution', duel.state, link, ruling);
        await this.commit(duel, [{ type: 'judged', record }, ...events, { type: 'linkResolved' }]);
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

  private async runJudge(duel: LiveDuel, stage: 'activation' | 'resolution', state: DuelState, link: ChainLink, appealRuling: string | null = null) {
    duel.judging = { stage, link, question: null };
    this.broadcastJudging(duel);
    try {
      return await rule(
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
    if (duel.events.some((e, i) => e.type === 'rolledBack' && i > seq && e.to <= seq)) return { ok: false, status: 409, error: 'A rewind undid that ruling.' };
    const key = `${seq}:${seat}`;
    const appeals = duel.events.filter((e) => e.type === 'appealed');
    if (duel.appealing.has(key) || appeals.some((e) => e.appeal.judged === seq && e.appeal.by === seat)) {
      return { ok: false, status: 409, error: 'You already contested this ruling.' };
    }
    if (appeals.length + duel.appealing.size >= this.ai.appeals) return { ok: false, status: 429, error: 'This duel has used all its appeals.' };
    duel.appealing.add(key);
    const input = { before: replay(duel.events.slice(0, seq)), now: duel.state, record: event.record, judged: seq, by: seat, note };
    void appeal(input, this.ai.appeal)
      .then(async (record) => {
        await this.enqueue(duel, () => this.commit(duel, [{ type: 'appealed', appeal: record }, ...this.rollbackOffer(duel, seq, record)]));
        // An overturned scripted ruling means the script is wrong: the judge takes the card over until it is fixed.
        if (record.verdict === 'overturned' && event.record.model === SCRIPT) {
          const code = cardOf(duel.state, event.record.card).code;
          await this.db.insert(sheetReports).values({ code, matchId: id, seq, reporter: 'appeal', note: record.ruling });
          await this.sheetChanged(code, await flagScripts(this.db, code, `appeal overturned a scripted ruling: ${record.ruling}`));
        }
      })
      .catch((error: unknown) => console.error(`Appeal in duel ${duel.id} failed:`, error))
      .finally(() => duel.appealing.delete(key));
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
        for (const l of duel.listeners) l.send(syncFor(duel, l.seat));
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

  /** Stores events, applies them, and sends each seat the steps. Commits happen one at a time, in call order. */
  private commit(duel: LiveDuel, events: DuelEvent[]): Promise<void> {
    const run = duel.writes.then(() => this.write(duel, events));
    duel.writes = run.catch(() => {});
    return run;
  }

  private async write(duel: LiveDuel, events: DuelEvent[]) {
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
    send(syncFor(duel, seat));
    return () => duel.listeners.delete(listener);
  }

  /**
   * Sends each seat one step per visible new event: the log entry and the board right after it, so the client
   * can animate events in order. Only the last step offers actions, since nobody may act mid-sequence.
   */
  private broadcast(before: DuelState, events: DuelEvent[], first: number, duel: LiveDuel) {
    const updateFor = (seat: Seat): Extract<DuelUpdate, { type: 'steps' }> => {
      let state = before;
      const steps: Extract<DuelUpdate, { type: 'steps' }>['steps'] = events.flatMap((event, i) => {
        state = evolve(state, event);
        const entry = entryFor(state, event, first + i, state.turn, seat);
        return entry ? [{ entry, view: viewFor(state, seat) }] : [];
      });
      // A change nobody sees in the log (a pass) still changes what each player may do.
      if (!entryFor(state, events.at(-1)!, first + events.length - 1, state.turn, seat)) steps.push({ entry: null, view: viewFor(state, seat) });
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

/** A record for an effect nobody could rule on: an activation is refused, an effect does nothing. */
function notRuled(state: DuelState, stage: 'activation' | 'resolution', player: Seat, card: string, effect: number, error: string): JudgeRecord {
  const name = cardOf(state, card).name;
  return {
    stage,
    player,
    card,
    effect,
    model: 'none',
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

const judgeCallsMade = (events: DuelEvent[]) => events.filter((e) => e.type === 'judged' && e.record.model !== SCRIPT).length;

/** The whole duel as one seat sees it now. */
const syncFor = (duel: LiveDuel, seat: Seat): DuelUpdate => ({ type: 'sync', view: viewFor(duel.state, seat), log: logFor(duel.events, seat), judging: judgingFor(duel, seat) });

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
