// Guests: people without an account who accepted a challenge link. A guest is created in the same
// transaction that seats them in a duel. Once none of their duels is going and the last one finished
// more than GUEST_GRACE_MS ago, the cleanup deletes them, so they can still look at the final board.

import { randomBytes } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db, Tx } from './db/client.ts';
import { guests, matches } from './db/schema.ts';
import { guestKey } from './viewer.ts';

type GuestRow = typeof guests.$inferSelect;

export const GUEST_GRACE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_EVERY_MS = 60 * 60 * 1000;

/** `matches` rows that seat the guest row being looked at. */
const seatsGuest = sql`(${matches.seat0} = 'guest:' || ${guests.id} or ${matches.seat1} = 'guest:' || ${guests.id})`;

export async function createGuest(tx: Tx, name: string): Promise<GuestRow> {
  const [row] = await tx.insert(guests).values({ token: randomBytes(24).toString('base64url'), name }).returning();
  return row!;
}

export async function findGuestByToken(db: Db, token: string): Promise<GuestRow | undefined> {
  return db.query.guests.findFirst({ where: eq(guests.token, token) });
}

/** Deletes guests with no duel going and none finished within the grace period. */
export async function deleteIdleGuests(db: Db, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - GUEST_GRACE_MS);
  const deleted = await db
    .delete(guests)
    .where(
      sql`not exists (select 1 from ${matches} where ${seatsGuest} and (${matches.status} <> 'finished' or ${matches.finishedAt} > ${cutoff}))`,
    )
    .returning({ id: guests.id });
  return deleted.length;
}

export function scheduleGuestCleanup(db: Db) {
  const run = () => deleteIdleGuests(db).catch((error: unknown) => console.error('Guest cleanup failed:', error));
  void run();
  return setInterval(run, CLEANUP_EVERY_MS);
}

/**
 * Moves a guest's seats to an approved account that signed in on the same browser, then deletes the
 * guest if no duel seats it any more. Guests only ever hold seat 1, since they can't create duels. A
 * seat stays with the guest when the account already holds seat 0 of that duel, since one player
 * can't hold both. Returns whether the guest is gone.
 */
export async function adoptGuest(db: Db, guestId: number, userKey: string): Promise<boolean> {
  const from = guestKey(guestId);
  return db.transaction(async (tx) => {
    await tx.update(matches).set({ seat1: userKey }).where(and(eq(matches.seat1, from), ne(matches.seat0, userKey)));
    const deleted = await tx
      .delete(guests)
      .where(and(eq(guests.id, guestId), sql`not exists (select 1 from ${matches} where ${seatsGuest})`))
      .returning({ id: guests.id });
    return deleted.length > 0;
  });
}
