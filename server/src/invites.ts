import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Invite, InvitePreview, InviteProblem } from '@yugioh/shared';
import type { Db } from './db/client.ts';
import { invites, users } from './db/schema.ts';

export const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

type InviteRow = typeof invites.$inferSelect;

function toInvite(row: InviteRow): Invite {
  return {
    token: row.token,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    redeemedAt: row.redeemedAt?.toISOString() ?? null,
  };
}

export async function createInvite(db: Db, userId: number): Promise<Invite> {
  const [row] = await db
    .insert(invites)
    .values({
      token: randomBytes(24).toString('base64url'),
      createdBy: userId,
      expiresAt: new Date(Date.now() + INVITE_LIFETIME_MS),
    })
    .returning();
  return toInvite(row!);
}

export async function listInvites(db: Db, userId: number): Promise<Invite[]> {
  const rows = await db.query.invites.findMany({
    where: eq(invites.createdBy, userId),
    orderBy: [desc(invites.createdAt)],
  });
  return rows.map(toInvite);
}

/** Deletes an invite, which also ends the guest access it granted. */
export async function revokeInvite(db: Db, userId: number, token: string): Promise<boolean> {
  const deleted = await db
    .delete(invites)
    .where(and(eq(invites.token, token), eq(invites.createdBy, userId)))
    .returning({ token: invites.token });
  return deleted.length > 0;
}

export type InviteLookup =
  | { ok: true; preview: InvitePreview; redeemed: boolean; createdBy: number }
  | { ok: false; problem: InviteProblem };

export async function lookupInvite(db: Db, token: string): Promise<InviteLookup> {
  const [row] = await db
    .select({ invite: invites, inviter: users })
    .from(invites)
    .innerJoin(users, eq(users.id, invites.createdBy))
    .where(eq(invites.token, token));
  if (!row) return { ok: false, problem: 'not_found' };
  // An invite whose creator lost approval stops working.
  if (row.inviter.status !== 'approved') return { ok: false, problem: 'not_found' };
  if (row.invite.expiresAt <= new Date()) return { ok: false, problem: 'expired' };
  return {
    ok: true,
    preview: {
      invitedBy: row.inviter.name ?? row.inviter.email ?? 'a player',
      expiresAt: row.invite.expiresAt.toISOString(),
    },
    redeemed: row.invite.redeemedAt !== null,
    createdBy: row.invite.createdBy,
  };
}

/** Marks an unused, unexpired invite as used. Returns false if someone else got there first. */
export async function markRedeemed(db: Db, token: string): Promise<boolean> {
  const updated = await db
    .update(invites)
    .set({ redeemedAt: new Date() })
    .where(and(eq(invites.token, token), isNull(invites.redeemedAt), gt(invites.expiresAt, new Date())))
    .returning({ token: invites.token });
  return updated.length > 0;
}
