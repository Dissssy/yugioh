import { and, asc, eq, ne, or, sql } from 'drizzle-orm';
import { defaultSettings, type AccountStatus, type AdminUser, type Logins, type Role, type User, type UserSettings } from '@yugioh/shared';
import type { Db } from './db/client.ts';
import { banlists, decks, matches, sheetReports, users } from './db/schema.ts';
import { randomUsername } from './usernames.ts';
import { userKey } from './viewer.ts';

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

export const loginsOf = (row: UserRow): Logins => ({ auth0: row.auth0Sub !== null, discord: row.discordId !== null });

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
  return withRandomUsername((username) =>
    db
      .insert(users)
      .values({ auth0Sub: claims.sub, email, username, role: isSuper ? 'superAdmin' : 'player', status: isSuper ? 'approved' : 'pending' })
      .onConflictDoUpdate({
        target: users.auth0Sub,
        set: isSuper
          ? { email, role: 'superAdmin', status: 'approved' }
          : { email, role: sql`case when ${users.role} = 'superAdmin' then 'player'::account_role else ${users.role} end` },
      })
      .returning(),
  );
}

/**
 * Creates or finds the account for someone signing in from the Discord Activity. Only the app's testers can open the
 * Activity, so they are trusted like approved players: a new account starts approved, and a pending one is approved.
 * An account an admin rejected stays rejected.
 */
export async function syncDiscordUser(db: Db, discordId: string): Promise<UserRow> {
  return withRandomUsername((username) =>
    db
      .insert(users)
      .values({ discordId, username, status: 'approved' })
      .onConflictDoUpdate({
        target: users.discordId,
        set: { status: sql`case when ${users.status} = 'pending' then 'approved'::account_status else ${users.status} end` },
      })
      .returning(),
  );
}

/** Finds or creates the account for a Discord login on the website. A new one starts pending, like any website signup. */
export async function syncWebDiscordUser(db: Db, discordId: string): Promise<UserRow> {
  return withRandomUsername((username) =>
    db
      .insert(users)
      .values({ discordId, username })
      // A no-op update, so the existing row comes back.
      .onConflictDoUpdate({ target: users.discordId, set: { discordId } })
      .returning(),
  );
}

/**
 * Joins an account with only an Auth0 login and one with only a Discord login into one account with both. The Auth0
 * account stays, unless only the Discord one is approved; the other's decks, banlists, duels and reports move to it
 * and it is deleted. Returns the account that stays, or an error to show.
 */
export async function linkAccounts(db: Db, auth0Id: number, discordId: number): Promise<UserRow | { error: string }> {
  if (auth0Id === discordId) return { error: 'Those logins are already one account.' };
  return db.transaction(async (tx) => {
    const a = await tx.query.users.findFirst({ where: eq(users.id, auth0Id) });
    const d = await tx.query.users.findFirst({ where: eq(users.id, discordId) });
    if (!a?.auth0Sub || !d?.discordId) return { error: "That login doesn't exist any more. Log in again." };
    if (a.discordId) return { error: 'This account already has a Discord login.' };
    if (d.auth0Sub) return { error: 'That Discord account is already linked to another website login.' };
    const [keep, gone] = d.status === 'approved' && a.status !== 'approved' ? [d, a] : [a, d];
    const [from, to] = [userKey(gone.id), userKey(keep.id)];
    const together = await tx.$count(matches, or(and(eq(matches.seat0, from), eq(matches.seat1, to)), and(eq(matches.seat0, to), eq(matches.seat1, from))));
    if (together > 0) return { error: "These two accounts have dueled each other, so they can't become one." };

    await tx.update(matches).set({ seat0: to }).where(eq(matches.seat0, from));
    await tx.update(matches).set({ seat1: to }).where(eq(matches.seat1, from));
    await tx.update(matches).set({ createdBy: keep.id }).where(eq(matches.createdBy, gone.id));
    await tx.update(decks).set({ ownerId: keep.id }).where(eq(decks.ownerId, gone.id));
    await tx.update(banlists).set({ ownerId: keep.id }).where(eq(banlists.ownerId, gone.id));
    await tx.update(sheetReports).set({ reporter: to }).where(eq(sheetReports.reporter, from));
    await tx.delete(users).where(eq(users.id, gone.id));
    const [row] = await tx.update(users).set({ auth0Sub: a.auth0Sub, discordId: d.discordId, email: a.email }).where(eq(users.id, keep.id)).returning();
    return row!;
  });
}

/** Runs an insert that gives a new account a random username, drawing again in the rare case it is taken. */
async function withRandomUsername(insert: (username: string) => Promise<UserRow[]>): Promise<UserRow> {
  for (let attempt = 1; ; attempt++) {
    try {
      const [row] = await insert(randomUsername());
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

export async function findUserByDiscordId(db: Db, discordId: string): Promise<UserRow | undefined> {
  return db.query.users.findFirst({ where: eq(users.discordId, discordId) });
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
