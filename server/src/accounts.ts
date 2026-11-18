import { asc, eq, sql } from 'drizzle-orm';
import type { AccountStatus, User } from '@yugioh/shared';
import type { Db } from './db/client.ts';
import { users } from './db/schema.ts';

/** The ID token claims we read from Auth0. */
export interface LoginClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

type UserRow = typeof users.$inferSelect;

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    status: row.status,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Creates or refreshes the account for a login. New accounts start pending; the
 * account whose verified email matches adminEmail is the admin and always approved.
 */
export async function syncUser(db: Db, claims: LoginClaims, adminEmail: string): Promise<UserRow> {
  const email = claims.email?.toLowerCase() ?? null;
  const isAdmin = claims.email_verified === true && email === adminEmail;
  const [row] = await db
    .insert(users)
    .values({
      auth0Sub: claims.sub,
      email,
      name: claims.name ?? null,
      isAdmin,
      status: isAdmin ? 'approved' : 'pending',
    })
    .onConflictDoUpdate({
      target: users.auth0Sub,
      set: {
        email,
        name: claims.name ?? null,
        isAdmin,
        status: isAdmin ? sql`'approved'` : sql`${users.status}`,
      },
    })
    .returning();
  return row!;
}

export async function findUserBySub(db: Db, sub: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.auth0Sub, sub) });
}

export async function listUsers(db: Db): Promise<User[]> {
  const rows = await db.query.users.findMany({ orderBy: [asc(users.createdAt)] });
  return rows.map(toUser);
}

/** Sets an account's status. The admin's own account can't be changed. */
export async function setStatus(db: Db, id: number, status: AccountStatus): Promise<User | undefined> {
  const [row] = await db
    .update(users)
    .set({ status })
    .where(sql`${users.id} = ${id} and not ${users.isAdmin}`)
    .returning();
  return row && toUser(row);
}
