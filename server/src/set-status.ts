// Where one set of the list stands on the way into the pool (docs/card-pool.md, "Adding a set"): each of its cards is
// a Normal Monster, has a sheet code writes, is scripted, leaves effects to the judge, has an effect that does
// nothing, or has no current sheet yet.
//
//   npm run sheets:status -- SDY

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { EffectSheet } from '@yugioh/engine';
import { poolCardIds, readCardSets } from './cards.ts';
import type { Db } from './db/client.ts';
import { cards } from './db/schema.ts';
import { SHEET_DIR } from './sheets.ts';

export type CardStatus = 'normal' | 'generated' | 'scripted' | 'judged' | 'inert' | 'missing';

export interface SetCard {
  code: number;
  name: string;
  status: CardStatus;
  /** Whether the card is in the pool, and so can be played. */
  inPool: boolean;
  /** For judged and inert cards: which effects, as "<index> <kind>". */
  effects: string[];
}

/** A card's status from its sheet: which effects code can't run, if any. */
export function statusOf(frameType: string, textHash: string, sheet: EffectSheet | null): Pick<SetCard, 'status' | 'effects'> {
  if (frameType === 'normal') return { status: 'normal', effects: [] };
  if (!sheet || sheet.textHash !== textHash) return { status: 'missing', effects: [] };
  if (sheet.model === 'generated') return { status: 'generated', effects: [] };
  const inert = sheet.effects.flatMap((e, i) => (e.kind === 'continuous' && !e.continuous ? [`${i} ${e.kind}`] : []));
  if (inert.length) return { status: 'inert', effects: inert };
  const judged = sheet.effects.flatMap((e, i) => (e.kind !== 'continuous' && !e.script ? [`${i} ${e.kind}`] : []));
  return judged.length ? { status: 'judged', effects: judged } : { status: 'scripted', effects: [] };
}

/** Every card printed in the set with this list code, with its status. */
export async function setStatus(db: Db, code: string, dir = SHEET_DIR): Promise<SetCard[]> {
  const set = (await readCardSets()).find((s) => s.code === code);
  if (!set?.ygoprodeck) throw new Error(`No set "${code}" with YGOPRODeck cards in card-sets.json`);
  const rows = await db
    .select()
    .from(cards)
    .where(sql`exists (select 1 from jsonb_array_elements(${cards.raw}->'card_sets') s where s->>'set_name' = ${set.ygoprodeck})`);
  const pool = new Set(await poolCardIds(db));
  const out: SetCard[] = [];
  for (const row of rows) {
    const path = join(dir, `${row.id}.json`);
    const sheet = existsSync(path) ? (JSON.parse(await readFile(path, 'utf8')) as EffectSheet) : null;
    out.push({ code: row.id, name: row.name, inPool: pool.has(row.id), ...statusOf(row.frameType, row.textHash, sheet) });
  }
  return out.sort((a, b) => a.status.localeCompare(b.status) || a.name.localeCompare(b.name));
}

if (import.meta.main) {
  const { connect } = await import('./db/client.ts');
  const db = connect(process.env.DATABASE_URL ?? '');
  const code = process.argv[2];
  if (!code) console.error('Usage: node src/set-status.ts <list code>');
  else {
    const found = await setStatus(db, code);
    for (const c of found) console.log(`${c.status.padEnd(9)} ${c.inPool ? '   ' : 'new'} ${c.name}${c.effects.length ? ` (effects ${c.effects.join(', ')})` : ''}`);
    const count = (s: string) => found.filter((c) => c.status === s).length;
    console.log(`\n${found.length} cards: ${['normal', 'generated', 'scripted', 'judged', 'inert', 'missing'].map((s) => `${count(s)} ${s}`).join(', ')}.`);
    const open = count('missing') + count('inert');
    console.log(open ? `Not ready: ${open} cards have no sheet or an effect that does nothing.` : 'Every card has a sheet. Judged cards must be listed in docs/card-pool.md.');
    process.exitCode = open ? 1 : 0;
  }
  await db.$client.end();
}
