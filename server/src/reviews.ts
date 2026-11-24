// Review requests: an admin sends a duel (a moment in it, maybe a card) to Claude, and a Claude thread working the
// queue with an admin API key claims it, fixes the cause and reports back. See docs/review-api.md.

import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { blockedAttacks, blockedEffects, legalActions, replay, type Blocked, type DuelState, type EffectSheet, type LegalAction } from '@yugioh/engine';
import type { ApiKey, ReviewRequest, ReviewStatus } from '@yugioh/shared';
import type { Db } from './db/client.ts';
import { apiKeys, cards, matchEvents, matches, reviewRequests, sheetRevisions, users } from './db/schema.ts';
import { matchReport, type MatchReport } from './matchReport.ts';
import { sheetOf } from './sheets.ts';

const hashOf = (key: string) => createHash('sha256').update(key).digest('hex');

/** Makes a key for the admin `userId`. Returns the key itself, which is never stored and can't be shown again. */
export async function createApiKey(db: Db, userId: number, name: string): Promise<{ id: number; key: string }> {
  const key = `ygo_${randomBytes(32).toString('base64url')}`;
  const [row] = await db.insert(apiKeys).values({ name, hash: hashOf(key), createdBy: userId }).returning({ id: apiKeys.id });
  return { id: row!.id, key };
}

export async function listApiKeys(db: Db): Promise<ApiKey[]> {
  const rows = await db
    .select({ id: apiKeys.id, name: apiKeys.name, createdBy: users.username, createdAt: apiKeys.createdAt, lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.createdBy))
    .orderBy(asc(apiKeys.id));
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null }));
}

/** Returns false if there is no such key. */
export async function revokeApiKey(db: Db, id: number): Promise<boolean> {
  return (await db.delete(apiKeys).where(eq(apiKeys.id, id)).returning({ id: apiKeys.id })).length > 0;
}

/** The account a key acts for, or null for an unknown key. Notes when the key was last used. */
export async function accountOfKey(db: Db, key: string) {
  const [row] = await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.hash, hashOf(key))).returning({ userId: apiKeys.createdBy });
  if (!row) return null;
  return (await db.query.users.findFirst({ where: eq(users.id, row.userId) })) ?? null;
}

type Row = typeof reviewRequests.$inferSelect;

async function toRequests(db: Db, rows: Row[]): Promise<ReviewRequest[]> {
  const ids = [...new Set(rows.map((r) => r.sentBy))];
  const codes = [...new Set(rows.flatMap((r) => (r.code === null ? [] : [r.code])))];
  const names = new Map(ids.length ? (await db.select({ id: users.id, name: users.username }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
  const cardNames = new Map(codes.length ? (await db.select({ id: cards.id, name: cards.name }).from(cards).where(inArray(cards.id, codes))).map((c) => [c.id, c.name]) : []);
  return rows.map((r) => ({
    id: r.id,
    matchId: r.matchId,
    seq: r.seq,
    code: r.code,
    cardName: r.code === null ? null : (cardNames.get(r.code) ?? null),
    note: r.note,
    sentBy: names.get(r.sentBy) ?? '?',
    status: r.status,
    result: r.result,
    prUrl: r.prUrl,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export interface NewReview {
  matchId: string;
  seq: number | null;
  code: number | null;
  note: string;
}

/** Saves a review request from admin `userId`. Returns null if the duel, its log entry `seq` or the card doesn't exist. */
export async function createReview(db: Db, userId: number, review: NewReview): Promise<ReviewRequest | null> {
  const match = await db.query.matches.findFirst({ where: eq(matches.id, review.matchId) });
  if (!match) return null;
  // The board is the one before entry `seq`, so `seq` may be one past the last entry: the duel as it is now.
  if (review.seq !== null && !(await db.query.matchEvents.findFirst({ where: and(eq(matchEvents.matchId, review.matchId), eq(matchEvents.seq, review.seq - 1)) }))) return null;
  if (review.code !== null && !(await db.query.cards.findFirst({ where: eq(cards.id, review.code) }))) return null;
  const [row] = await db.insert(reviewRequests).values({ ...review, sentBy: userId }).returning();
  return (await toRequests(db, [row!]))[0]!;
}

/** Every request, newest first, or only those with `status`. */
export async function listReviews(db: Db, status: ReviewStatus | null): Promise<ReviewRequest[]> {
  const rows = await db
    .select()
    .from(reviewRequests)
    .where(status ? eq(reviewRequests.status, status) : undefined)
    .orderBy(desc(reviewRequests.id));
  return toRequests(db, rows);
}

/** Moves a request on (claimed, fixed, won't fix, or open again), with Claude's finding and pull request if any. */
export async function updateReview(db: Db, id: number, change: { status: ReviewStatus; result?: string; prUrl?: string }): Promise<ReviewRequest | null> {
  const [row] = await db
    .update(reviewRequests)
    .set({ ...change, updatedAt: new Date() })
    .where(eq(reviewRequests.id, id))
    .returning();
  return row ? (await toRequests(db, [row]))[0]! : null;
}

/** What a player could do, and why not the rest, on the board a review is about. */
interface SeatChoices {
  actions: LegalAction[];
  blocked: Blocked[];
}

/** Everything a Claude thread needs to look at a request again, in one document. */
export interface ReviewBundle {
  request: ReviewRequest;
  /** The commit of the running image, so the thread reads the code that ran. */
  commit: string | null;
  /** The whole duel with nothing hidden: every event, judge transcripts included. */
  report: MatchReport;
  /** The board just before log entry `seq` (after the last one for the duel as a whole), with what each player could do there. */
  board: { before: number; state: DuelState; seats: [SeatChoices, SeatChoices] };
  /** The card the request names: its text, its sheet now, and every version it had. */
  card: { code: number; name: string; text: string; sheet: EffectSheet | null; revisions: { sheet: EffectSheet; reason: string; createdAt: string }[] } | null;
}

export async function reviewBundle(db: Db, id: number, commit: string | null): Promise<ReviewBundle | null> {
  const row = await db.query.reviewRequests.findFirst({ where: eq(reviewRequests.id, id) });
  if (!row) return null;
  const [request] = await toRequests(db, [row]);
  const report = (await matchReport(db, row.matchId))!;
  const before = row.seq ?? report.events.length;
  const state = replay(report.events.slice(0, before).map((e) => e.event));
  const choices = (seat: 0 | 1): SeatChoices => {
    const actions = legalActions(state, seat);
    return { actions, blocked: [...blockedEffects(state, seat, actions), ...blockedAttacks(state, seat)] };
  };
  let card: ReviewBundle['card'] = null;
  if (row.code !== null) {
    const data = (await db.query.cards.findFirst({ where: eq(cards.id, row.code) }))!;
    const revisions = await db.select().from(sheetRevisions).where(eq(sheetRevisions.code, row.code)).orderBy(asc(sheetRevisions.id));
    card = {
      code: data.id,
      name: data.name,
      text: data.text,
      sheet: await sheetOf(db, row.code),
      revisions: revisions.map((r) => ({ sheet: r.sheet, reason: r.reason, createdAt: r.createdAt.toISOString() })),
    };
  }
  return { request: request!, commit, report, board: { before, state, seats: [choices(0), choices(1)] }, card };
}
