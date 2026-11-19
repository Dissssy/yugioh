// Effect sheets: each card's effects, read once from its text by a strong model and stored as reviewable JSON files
// in server/effect-sheets/<passcode>.json. A duel copies the sheets of its cards into its first event.
//
// `npm run sheets:compile` writes a sheet for every premade-deck card with an effect that has none, or whose text
// changed since (errata), using the Message Batches API. A sheet marked `verified` is never overwritten.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { CardData, EffectSheet } from '@yugioh/engine';
import type { Db } from './db/client.ts';
import { cards, decks } from './db/schema.ts';

export const SHEET_DIR = fileURLToPath(new URL('../effect-sheets', import.meta.url));
export const COMPILE_MODEL = 'claude-opus-5-5';

export const textHash = (text: string) => createHash('sha256').update(text).digest('hex');

const sheetEffect = z.object({
  kind: z.enum(['activation', 'ignition', 'trigger', 'quick', 'continuous', 'flip', 'condition']),
  speed: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  mandatory: z.boolean(),
  opt: z.enum(['none', 'soft', 'hard']),
  window: z.string(),
  cost: z.string(),
  effect: z.string(),
  targets: z.string().nullable(),
});

/** What the compiling model returns for one card. */
const compiled = z.object({ effects: z.array(sheetEffect), materials: z.string().nullable() });

const sheetFile = compiled.extend({
  code: z.number().int(),
  textHash: z.string(),
  verified: z.boolean(),
  model: z.string(),
}) satisfies z.ZodType<EffectSheet>;

const sheetPath = (code: number, dir: string) => join(dir, `${code}.json`);

async function readSheet(code: number, dir: string): Promise<EffectSheet | null> {
  const path = sheetPath(code, dir);
  if (!existsSync(path)) return null;
  return sheetFile.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** Sheets for the given cards, keyed by passcode. A card without a current sheet acts as if it had no effects. */
export async function loadSheets(cardData: Record<number, CardData>, dir = SHEET_DIR): Promise<Record<number, EffectSheet>> {
  const sheets: Record<number, EffectSheet> = {};
  for (const card of Object.values(cardData)) {
    const sheet = await readSheet(card.code, dir);
    if (!sheet) continue;
    if (sheet.textHash !== textHash(card.text)) {
      console.warn(`Effect sheet for ${card.name} (${card.code}) is out of date; run npm run sheets:compile.`);
      continue;
    }
    sheets[card.code] = sheet;
  }
  return sheets;
}

const COMPILE_PROMPT = `You turn one Yu-Gi-Oh! card's official text into an effect sheet for a duel engine. Code runs the generic rules (phases, summons, battle, chain, once-per-turn counting); a runtime judge reads your sheet and the card text to apply each effect. Be exact about the card's own wording.

List the card's effects in the order they appear in the text. For each:
- kind: "activation" for activating a Spell/Trap card itself (every Spell/Trap has exactly one, even a Continuous one whose activation does nothing by itself; "effect" then says so); "ignition", "trigger", "quick" or "flip" for activated monster effects; "continuous" for effects that are always on and never activated (including a Spell/Trap's ongoing effect and "this card remains on the field"); "condition" for summoning conditions or procedures. A trigger effect of a Spell/Trap ("When this card leaves the field: destroy ...") is "trigger".
- speed: spell speed. Normal Spells, ignition and trigger effects 1; Quick-Play Spells, Normal and Continuous Traps and quick effects 2; Counter Traps 3. Continuous effects and conditions 1.
- mandatory: for triggers, true unless the text says "you can". false for everything else.
- opt: "soft" for "once per turn" (or "once per Battle Phase") on this copy, "hard" for "you can only use this effect of <name> once per turn", else "none".
- window: when it can be activated or applies, in plain words, including activation conditions such as "if you control a Synchro Monster".
- cost: the cost exactly as worded (the part before the colon or semicolon that is paid to activate), or "".
- effect: what the effect does, as worded on the card.
- targets: what it targets, as worded, or null if it doesn't target.
materials: an Extra Deck monster's materials as worded, else null. Normal Monsters (flavour text) have no effects: return an empty list.`;

/** Premade-deck cards with text that need a new sheet. */
async function cardsToCompile(db: Db, dir: string, force: boolean) {
  const all = await db.select({ main: decks.main, extra: decks.extra }).from(decks);
  const ids = [...new Set(all.flatMap((d) => [...d.main, ...d.extra]))];
  const rows = ids.length ? await db.select().from(cards).where(inArray(cards.id, ids)) : [];
  const todo = [];
  for (const row of rows) {
    if (row.frameType === 'normal') continue;
    const sheet = await readSheet(row.id, dir);
    if (sheet?.verified) continue;
    if (!force && sheet?.textHash === row.textHash) continue;
    todo.push(row);
  }
  return todo;
}

export async function compileSheets(db: Db, options: { dir?: string; force?: boolean; log?: (m: string) => void; client?: Anthropic }) {
  const { dir = SHEET_DIR, force = false, log = () => {} } = options;
  const todo = await cardsToCompile(db, dir, force);
  if (todo.length === 0) return log('Every sheet is up to date.');
  log(`Compiling ${todo.length} effect sheets with ${COMPILE_MODEL}…`);
  const client = options.client ?? new Anthropic();
  const schema = z.toJSONSchema(compiled);
  const batch = await client.messages.batches.create({
    requests: todo.map((row) => ({
      custom_id: String(row.id),
      params: {
        model: COMPILE_MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema } },
        system: COMPILE_PROMPT,
        messages: [{ role: 'user', content: `Name: ${row.name}\nType: ${row.type}\nProperty/Race: ${row.race}\n\n${row.text}` }],
      },
    })),
  });
  let status = batch;
  while (status.processing_status !== 'ended') {
    await sleep(30_000);
    status = await client.messages.batches.retrieve(batch.id);
    log(`Batch ${batch.id}: ${status.request_counts.succeeded} done, ${status.request_counts.processing} processing`);
  }
  const byId = new Map(todo.map((row) => [String(row.id), row]));
  for await (const result of await client.messages.batches.results(batch.id)) {
    const row = byId.get(result.custom_id)!;
    if (result.result.type !== 'succeeded') {
      log(`${row.name}: ${result.result.type}`);
      continue;
    }
    const text = result.result.message.content.find((b) => b.type === 'text');
    const parsed = text ? compiled.safeParse(JSON.parse(text.text)) : null;
    if (!parsed?.success) {
      log(`${row.name}: the model's sheet didn't parse`);
      continue;
    }
    const sheet: EffectSheet = { code: row.id, textHash: row.textHash, verified: false, model: COMPILE_MODEL, ...parsed.data };
    await writeFile(sheetPath(row.id, dir), `${JSON.stringify(sheet, null, 2)}\n`);
    log(`${row.name}: written`);
  }
}

/** All sheet files, for tests and reviews. */
export async function listSheetCodes(dir = SHEET_DIR): Promise<number[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => Number(f.slice(0, -5)));
}

if (import.meta.main) {
  const { connect } = await import('./db/client.ts');
  const db = connect(process.env.DATABASE_URL ?? '');
  await compileSheets(db, { force: process.argv.includes('--force'), log: console.log });
  await db.$client.end();
}
