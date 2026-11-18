import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

export function connect(databaseUrl: string) {
  return drizzle(databaseUrl, { schema });
}

export type Db = ReturnType<typeof connect>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
