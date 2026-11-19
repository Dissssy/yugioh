import { asc, eq, sql } from 'drizzle-orm';
import type { AccountStatus, AdminUser, User } from '@yugioh/shared';
import type { Db } from './db/client.ts';
import { users } from './db/schema.ts';
import { randomUsername } from './usernames.ts';

/** The ID token claims we read from Auth0. */
export interface LoginClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

type UserRow = typeof users.$inferSelect;

export function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    status: row.status,
    isAdmin: row.isAdmin,
    createdAt: row.createdAt.toISOString(),
  };
}

const toAdminUser = (row: UserRow): AdminUser => ({ ...toUser(row), email: row.email });

/** Whether a query failed because the username is already taken. */
function isUsernameTaken(error: unknown): boolean {
  const pg = (error instanceof Error && error.cause) || error;
  return (pg as { constraint?: string } | null)?.constraint === 'users_username_lower_unique';
}

/**
 * Creates or refreshes the account for a login. New accounts start pending with a random username;
 * the account whose verified email matches adminEmail is the admin and always approved.
 */
export async function syncUser(db: Db, claims: LoginClaims, adminEmail: string): Promise<UserRow> {
  const email = claims.email?.toLowerCase() ?? null;
  const isAdmin = claims.email_verified === true && email === adminEmail;
  // A random username is rarely taken already; draw again when it is.
  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await db
        .insert(users)
        .values({ auth0Sub: claims.sub, email, username: randomUsername(), isAdmin, status: isAdmin ? 'approved' : 'pending' })
        .onConflictDoUpdate({
          target: users.auth0Sub,
          set: { email, isAdmin, status: isAdmin ? sql`'approved'` : sql`${users.status}` },
        })
        .returning();
      return row!;
    } catch (error) {
      if (attempt >= 5 || !isUsernameTaken(error)) throw error;
    }
  }
}

/** Renames an account. Returns null when another account has that name, in any letter case. */
export async function setUsername(db: Db, id: number, username: string): Promise<User | null> {
  try {
    const [row] = await db.update(users).set({ username }).where(eq(users.id, id)).returning();
    return toUser(row!);
  } catch (error) {
    if (isUsernameTaken(error)) return null;
    throw error;
  }
}

export async function findUserBySub(db: Db, sub: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.auth0Sub, sub) });
}

export async function listUsers(db: Db): Promise<AdminUser[]> {
  const rows = await db.query.users.findMany({ orderBy: [asc(users.createdAt)] });
  return rows.map(toAdminUser);
}

/** Sets an account's status. The admin's own account can't be changed. */
export async function setStatus(db: Db, id: number, status: AccountStatus): Promise<AdminUser | undefined> {
  const [row] = await db
    .update(users)
    .set({ status })
    .where(sql`${users.id} = ${id} and not ${users.isAdmin}`)
    .returning();
  return row && toAdminUser(row);
}
