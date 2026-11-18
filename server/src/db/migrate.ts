import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Db } from './client.ts';

export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(db: Db) {
  await migrate(db, { migrationsFolder });
}

if (import.meta.main) {
  const { connect } = await import('./client.ts');
  const db = connect(process.env.DATABASE_URL ?? '');
  await runMigrations(db);
  await db.$client.end();
  console.log('Migrations applied.');
}
