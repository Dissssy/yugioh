import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { defaultSettings, type AccountStatus, type AdminUser, type Role, type User, type UserSettings } from '@yugioh/shared';
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
    role: row.role,
    createdAt: row.createdAt.toISOString(),
  };
}

export const settingsOf = (row: UserRow): UserSettings => ({ ...defaultSettings, ...row.settings });

const toAdminUser = (row: UserRow): AdminUser => ({ ...toUser(row), email: row.email });

/** Whether a query failed because the username is already taken. */
function isUsernameTaken(error: unknown): boolean {
  const pg = (error instanceof Error && error.cause) || error;
  return (pg as { constraint?: string } | null)?.constraint === 'users_username_lower_unique';
}

/**
 * Creates or refreshes the account for a login. New accounts start pending with a random username. The account whose
 * verified email matches adminEmail is the super admin and always approved; an account that no longer matches it
 * goes back to being a player.
 */
export async function syncUser(db: Db, claims: LoginClaims, adminEmail: string): Promise<UserRow> {
  const email = claims.email?.toLowerCase() ?? null;
  const isSuper = claims.email_verified === true && email === adminEmail;
  // A random username is rarely taken already; draw again when it is.
  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await db
        .insert(users)
        .values({ auth0Sub: claims.sub, email, username: randomUsername(), role: isSuper ? 'superAdmin' : 'player', status: isSuper ? 'approved' : 'pending' })
        .onConflictDoUpdate({
          target: users.auth0Sub,
          set: isSuper
            ? { email, role: 'superAdmin', status: 'approved' }
            : { email, role: sql`case when ${users.role} = 'superAdmin' then 'player'::account_role else ${users.role} end` },
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

/** Changes some of an account's settings and returns them all. */
export async function updateSettings(db: Db, id: number, change: Partial<UserSettings>): Promise<UserSettings> {
  const [row] = await db
    .update(users)
    .set({ settings: sql`${users.settings} || ${JSON.stringify(change)}::jsonb` })
    .where(eq(users.id, id))
    .returning();
  return settingsOf(row!);
}

export async function findUserBySub(db: Db, sub: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.auth0Sub, sub) });
}

export async function listUsers(db: Db): Promise<AdminUser[]> {
  const rows = await db.query.users.findMany({ orderBy: [asc(users.createdAt)] });
  return rows.map(toAdminUser);
}

/** Sets a player's status. Admins' accounts can't be changed: the super admin takes their admin away first. */
export async function setStatus(db: Db, id: number, status: AccountStatus): Promise<AdminUser | undefined> {
  const [row] = await db
    .update(users)
    .set({ status })
    .where(and(eq(users.id, id), eq(users.role, 'player')))
    .returning();
  return row && toAdminUser(row);
}

/** Makes an approved account an admin or a player again. The super admin's own account can't be changed. */
export async function setRole(db: Db, id: number, role: Exclude<Role, 'superAdmin'>): Promise<AdminUser | undefined> {
  const [row] = await db
    .update(users)
    .set({ role })
    .where(and(eq(users.id, id), ne(users.role, 'superAdmin'), eq(users.status, 'approved')))
    .returning();
  return row && toAdminUser(row);
}
