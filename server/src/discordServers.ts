// The Discord servers the Activity has been opened in, and which of them an admin trusts (docs/discord.md).
import type { DiscordServer } from '@yugioh/shared';
import { desc, eq } from 'drizzle-orm';
import type { Db } from './db/client.ts';
import { discordServers, users } from './db/schema.ts';

/** Records that the Activity was opened in a server. Returns whether it's trusted. */
export async function serverOpened(db: Db, id: string): Promise<boolean> {
  const [row] = await db
    .insert(discordServers)
    .values({ id })
    .onConflictDoUpdate({ target: discordServers.id, set: { lastOpenedAt: new Date() } })
    .returning();
  return row!.trusted;
}

/** Notes who opened it last, once their account exists, so the admin can tell which server an ID is. */
export async function serverOpenedBy(db: Db, id: string, account: number) {
  await db.update(discordServers).set({ lastOpenedBy: account }).where(eq(discordServers.id, id));
}

export async function listServers(db: Db): Promise<DiscordServer[]> {
  const rows = await db
    .select({ server: discordServers, by: users.username })
    .from(discordServers)
    .leftJoin(users, eq(users.id, discordServers.lastOpenedBy))
    .orderBy(desc(discordServers.lastOpenedAt));
  return rows.map(({ server, by }) => ({ id: server.id, trusted: server.trusted, lastOpenedAt: server.lastOpenedAt.toISOString(), lastOpenedBy: by }));
}

/** Returns false when no such server has been seen. */
export async function setTrusted(db: Db, id: string, trusted: boolean): Promise<boolean> {
  const rows = await db.update(discordServers).set({ trusted }).where(eq(discordServers.id, id)).returning();
  return rows.length > 0;
}
