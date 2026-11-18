// Running duels. The server is the only authority: it holds each duel's event log, turns player
// intents into events with the engine, stores them, and pushes each seat its own filtered view.
//
// Live duels are kept in memory by this process and rebuilt from the log on first use, so the site
// must run as a single server process.

import { randomBytes, randomInt } from 'node:crypto';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import {
  decide,
  evolve,
  replay,
  startDuel,
  viewFor,
  type DuelEvent,
  type DuelState,
  type Intent,
  type PlayerView,
  type Seat,
} from '@yugioh/engine';
import type { DuelSummary } from '@yugioh/shared';
import { loadCards } from './cards.ts';
import type { Db } from './db/client.ts';
import { decks, matchEvents, matches, users } from './db/schema.ts';

type MatchRow = typeof matches.$inferSelect;

interface LiveDuel {
  id: string;
  seats: [string, string];
  events: DuelEvent[];
  state: DuelState;
  listeners: Set<{ seat: Seat; send: (view: PlayerView) => void }>;
  /** Intents for one duel are handled one at a time, in arrival order. */
  queue: Promise<unknown>;
}

export type ActResult = { ok: true } | { ok: false; status: number; error: string };

/** A random float in [0, 1) from the system's secure generator, for shuffles and the coin toss. */
const secureRandom = () => randomInt(2 ** 47) / 2 ** 47;

export class Duels {
  private live = new Map<string, Promise<LiveDuel>>();
  private db: Db;
  constructor(db: Db) {
    this.db = db;
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

  /** Duels the player sits in, plus open challenges from `challengerId` (a guest's inviter). */
  async list(seatKey: string, challengerId: number | null): Promise<MatchRow[]> {
    const open = challengerId === null ? sql`false` : and(eq(matches.status, 'waiting'), eq(matches.createdBy, challengerId));
    return this.db.query.matches.findMany({
      where: or(eq(matches.seat0, seatKey), eq(matches.seat1, seatKey), open),
      orderBy: [desc(matches.createdAt)],
      limit: 30,
    });
  }

  async summarize(row: MatchRow, seatKey: string | null, canJoin: boolean): Promise<DuelSummary> {
    const [creator] = await this.db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, row.createdBy));
    const deckName = async (id: number | null) =>
      id === null ? null : ((await this.db.query.decks.findFirst({ where: eq(decks.id, id) }))?.name ?? null);
    return {
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      createdBy: creator?.name ?? creator?.email ?? 'a player',
      decks: [(await deckName(row.deck0)) ?? '', await deckName(row.deck1)],
      yourSeat: seatKey === row.seat0 ? 0 : seatKey === row.seat1 ? 1 : null,
      canJoin: canJoin && row.status === 'waiting' && seatKey !== row.seat0,
    };
  }

  /** Takes the empty seat and deals the opening hands. Returns false if the seat was already taken. */
  async join(id: string, seatKey: string, deckId: number, names: [string, string]): Promise<boolean> {
    const started = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(matches)
        .set({ seat1: seatKey, deck1: deckId, status: 'active' })
        .where(and(eq(matches.id, id), eq(matches.status, 'waiting'), sql`${matches.seat0} <> ${seatKey}`))
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
            { name: names[0], main: deck0.main, extra: deck0.extra },
            { name: names[1], main: deck1.main, extra: deck1.extra },
          ],
          cards,
        },
        secureRandom,
      );
      await tx.insert(matchEvents).values(events.map((event, seq) => ({ matchId: id, seq, event })));
      return true;
    });
    return started;
  }

  private load(id: string): Promise<LiveDuel> {
    let duel = this.live.get(id);
    if (!duel) {
      duel = (async () => {
        const row = await this.find(id);
        if (!row?.seat1) throw new Error(`Duel ${id} has not started`);
        const rows = await this.db.select().from(matchEvents).where(eq(matchEvents.matchId, id)).orderBy(matchEvents.seq);
        const events = rows.map((r) => r.event as DuelEvent);
        return { id, seats: [row.seat0, row.seat1], events, state: replay(events), listeners: new Set(), queue: Promise.resolve() };
      })();
      duel.catch(() => this.live.delete(id));
      this.live.set(id, duel);
    }
    return duel;
  }

  /** Which seat a player holds in a started duel, if any. */
  async seatOf(id: string, seatKey: string): Promise<Seat | null> {
    const duel = await this.load(id);
    const seat = duel.seats.indexOf(seatKey);
    return seat === 0 || seat === 1 ? seat : null;
  }

  async act(id: string, seatKey: string, intent: Intent): Promise<ActResult> {
    const duel = await this.load(id);
    const run = duel.queue.then(async (): Promise<ActResult> => {
      const seat = duel.seats.indexOf(seatKey);
      if (seat !== 0 && seat !== 1) return { ok: false, status: 403, error: "You're not playing in this duel." };
      const decision = decide(duel.state, seat, intent);
      if (!decision.ok) return { ok: false, status: 422, error: decision.error };
      const first = duel.events.length;
      await this.db.transaction(async (tx) => {
        await tx.insert(matchEvents).values(decision.events.map((event, i) => ({ matchId: id, seq: first + i, event })));
        if (decision.events.some((e) => e.type === 'duelEnded')) {
          await tx.update(matches).set({ status: 'finished' }).where(eq(matches.id, id));
        }
      });
      duel.events.push(...decision.events);
      duel.state = decision.events.reduce(evolve, duel.state);
      this.broadcast(duel);
      return { ok: true };
    });
    duel.queue = run.catch(() => undefined);
    return run;
  }

  /** Sends the seat its view now and after every change. Returns the unsubscribe function. */
  async watch(id: string, seat: Seat, send: (view: PlayerView) => void): Promise<() => void> {
    const duel = await this.load(id);
    const listener = { seat, send };
    duel.listeners.add(listener);
    send(viewFor(duel.state, duel.events, seat));
    return () => duel.listeners.delete(listener);
  }

  private broadcast(duel: LiveDuel) {
    const views = [viewFor(duel.state, duel.events, 0), viewFor(duel.state, duel.events, 1)] as const;
    for (const l of duel.listeners) l.send(views[l.seat]);
  }
}
