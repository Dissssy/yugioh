// Effect sheets: each card's effects, read once from its text by a strong model. They live in the database, where
// the compiler, players' reports and the admin change them, with every version kept (see docs/effects.md). A duel
// copies its cards' sheets into its first event, and a change during the duel joins its log as `sheetUpdated`.
//
//   npm run sheets:compile                    sheets for premade-deck cards that have none or whose text changed
//   npm run sheets:compile -- --force [names] recompile all of them, or only the named cards
//   npm run sheets:import [-- --force]        load server/effect-sheets/*.json into the database (missing ones only)
//   npm run sheets:export                     write every sheet in the database to server/effect-sheets/
//
// A sheet with a verified effect is never recompiled.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import Anthropic from '@anthropic-ai/sdk';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { DESTINATIONS, UNTIL, type CardData, type CardFilter, type ModelUsage, type EffectSheet, type Script, type Selection, type SheetEffect, type Step } from '@yugioh/engine';
import type { Db } from './db/client.ts';
import { cards, decks, effectSheets, sheetRevisions } from './db/schema.ts';
import { costOf, usageOf } from './judge/pricing.ts';
import { strictSchema } from './judge/tools.ts';

export const SHEET_DIR = fileURLToPath(new URL('../effect-sheets', import.meta.url));
export const COMPILE_MODEL = 'claude-opus-5-5';

export const textHash = (text: string) => createHash('sha256').update(text).digest('hex');

const range = z.object({ min: z.number().int().nullable(), max: z.number().int().nullable() }).nullable();

const cardFilter = z.object({
  side: z.enum(['you', 'opponent', 'either']),
  place: z.enum(['field', 'monsters', 'spellTraps', 'hand', 'deck', 'graveyard', 'banished']),
  kinds: z.array(z.enum(['monster', 'spell', 'trap'])),
  types: z.array(z.string()),
  races: z.array(z.string()),
  attributes: z.array(z.string()),
  faceUp: z.boolean().nullable(),
  position: z.enum(['attack', 'defense']).nullable(),
  level: range,
  atk: range,
  def: range,
}) satisfies z.ZodType<CardFilter>;

const selection = z.union([
  z.object({ from: z.literal('self') }),
  z.object({ from: z.literal('targets') }),
  z.object({
    from: z.literal('choose'),
    filter: cardFilter,
    min: z.number().int(),
    max: z.number().int(),
    rank: z.object({ stat: z.enum(['atk', 'def', 'level']), order: z.enum(['lowest', 'highest']) }).nullable(),
  }),
  z.object({ from: z.literal('all'), filter: cardFilter }),
]) satisfies z.ZodType<Selection>;

const player = z.enum(['you', 'opponent']);
const step = z.union([
  z.object({ do: z.literal('destroy'), cards: selection }),
  z.object({ do: z.literal('move'), cards: selection, to: z.enum(DESTINATIONS) }),
  z.object({ do: z.literal('special_summon'), cards: selection, position: z.enum(['attack', 'defense', 'choice']) }),
  z.object({
    do: z.literal('modify_stats'),
    cards: selection,
    atk: z.number().int(),
    def: z.number().int(),
    levelDelta: z.number().int(),
    levelSet: z.number().int().nullable(),
    until: z.enum(UNTIL),
  }),
  z.object({ do: z.literal('change_lp'), player, amount: z.number().int(), kind: z.enum(['cost', 'damage', 'gain']) }),
  z.object({ do: z.literal('draw'), player, count: z.number().int() }),
  z.object({ do: z.literal('extra_normal_summon') }),
]) satisfies z.ZodType<Step>;

const script = z.object({
  conditions: z.array(
    z.union([z.object({ if: z.literal('count'), filter: cardFilter, min: z.number().int() }), z.object({ if: z.literal('before_battle_phase') })]),
  ),
  cost: z.array(step),
  targets: z.object({ filter: cardFilter, min: z.number().int(), max: z.number().int() }).nullable(),
  options: z.array(z.object({ label: z.string(), steps: z.array(step) })),
  unapplied: z.string().nullable(),
}) satisfies z.ZodType<Script>;

const sheetEffect = z.object({
  kind: z.enum(['activation', 'ignition', 'trigger', 'quick', 'continuous', 'flip', 'condition']),
  speed: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  mandatory: z.boolean(),
  opt: z.enum(['none', 'soft', 'hard']),
  window: z.string(),
  cost: z.string(),
  effect: z.string(),
  targets: z.string().nullable(),
  respondsTo: z.enum(['attack', 'summon', 'activation']).nullable(),
  script: script.nullable(),
  status: z.enum(['unverified', 'verified', 'flagged']),
}) satisfies z.ZodType<SheetEffect>;

/**
 * What the compiling model returns for one card. Each script comes back as JSON text and is checked here: its schema
 * has more unions than structured outputs accept.
 */
const compiled = z.object({
  effects: z.array(sheetEffect.omit({ speed: true, status: true }).extend({ script: z.string().nullable() })),
  materials: z.string().nullable(),
});

/** An effect's spell speed follows from its kind and the card's type, so code sets it rather than the model. */
export function speedOf(kind: SheetEffect['kind'], card: { type: string; race: string }): SheetEffect['speed'] {
  if (kind === 'quick') return 2;
  if (kind !== 'activation') return 1;
  return card.race === 'Counter' ? 3 : card.type.includes('Trap') || card.race === 'Quick-Play' ? 2 : 1;
}

/** A whole sheet, as stored and as the admin edits it. */
export const sheetSchema = z.object({
  code: z.number().int(),
  textHash: z.string(),
  model: z.string(),
  effects: z.array(sheetEffect),
  materials: z.string().nullable(),
}) satisfies z.ZodType<EffectSheet>;

/** Sheets for the given cards, keyed by passcode. A card without a current sheet acts as if it had no effects. */
export async function loadSheets(db: Db, cardData: Record<number, CardData>): Promise<Record<number, EffectSheet>> {
  const codes = Object.keys(cardData).map(Number);
  const rows = codes.length ? await db.select().from(effectSheets).where(inArray(effectSheets.code, codes)) : [];
  return current(cardData, rows.map((r) => r.sheet));
}

/** The sheets that match their card's text. */
function current(cardData: Record<number, CardData>, sheets: EffectSheet[]): Record<number, EffectSheet> {
  const result: Record<number, EffectSheet> = {};
  for (const sheet of sheets) {
    const card = cardData[sheet.code];
    if (!card) continue;
    if (sheet.textHash !== textHash(card.text)) {
      console.warn(`Effect sheet for ${card.name} (${card.code}) is out of date; run npm run sheets:compile.`);
      continue;
    }
    result[sheet.code] = sheet;
  }
  return result;
}

/** Stores a new version of a sheet and keeps the old ones. */
export async function saveSheet(db: Db, sheet: EffectSheet, reason: string): Promise<void> {
  const checked = sheetSchema.parse(sheet);
  await db.transaction(async (tx) => {
    await tx
      .insert(effectSheets)
      .values({ code: checked.code, sheet: checked })
      .onConflictDoUpdate({ target: effectSheets.code, set: { sheet: checked, updatedAt: new Date() } });
    await tx.insert(sheetRevisions).values({ code: checked.code, sheet: checked, reason });
  });
}

/** A card's sheet now, if it has one. */
export async function sheetOf(db: Db, code: number): Promise<EffectSheet | null> {
  return (await db.query.effectSheets.findFirst({ where: eq(effectSheets.code, code) }))?.sheet ?? null;
}

/** Sets aside every script on a card's sheet, so the judge rules on it from now on. Returns the new sheet, or null if it had no script to set aside. */
export async function flagScripts(db: Db, code: number, reason: string): Promise<EffectSheet | null> {
  const sheet = await sheetOf(db, code);
  if (!sheet?.effects.some((e) => e.script && e.status !== 'flagged')) return null;
  const flagged = { ...sheet, effects: sheet.effects.map((e) => (e.script ? { ...e, status: 'flagged' as const } : e)) };
  await saveSheet(db, flagged, reason);
  return flagged;
}

const sheetPath = (code: number, dir: string) => join(dir, `${code}.json`);

/** The sheet files in `dir` that match the given cards' text, for tests and `sheets:import`. */
export async function readSheetFiles(cardData: Record<number, CardData>, dir = SHEET_DIR): Promise<Record<number, EffectSheet>> {
  const sheets: EffectSheet[] = [];
  for (const code of Object.keys(cardData).map(Number)) {
    if (existsSync(sheetPath(code, dir))) sheets.push(sheetSchema.parse(JSON.parse(await readFile(sheetPath(code, dir), 'utf8'))));
  }
  return current(cardData, sheets);
}

/** Loads the sheet files into the database: those it lacks, or with `force` all of them. Returns how many. */
export async function importSheetFiles(db: Db, options: { dir?: string; force?: boolean } = {}): Promise<number> {
  const { dir = SHEET_DIR, force = false } = options;
  const codes = await listSheetCodes(dir);
  const rows = codes.length ? await db.select().from(cards).where(inArray(cards.id, codes)) : [];
  const files = await readSheetFiles(Object.fromEntries(rows.map((r) => [r.id, { code: r.id, name: r.name, text: r.text } as CardData])), dir);
  const have = new Set((await db.select({ code: effectSheets.code }).from(effectSheets)).map((r) => r.code));
  let n = 0;
  for (const sheet of Object.values(files)) {
    if (!force && have.has(sheet.code)) continue;
    await saveSheet(db, sheet, 'imported');
    n++;
  }
  return n;
}

/** Writes every sheet in the database to `dir`, one file per card. */
export async function exportSheetFiles(db: Db, dir = SHEET_DIR): Promise<number> {
  const rows = await db.select().from(effectSheets);
  for (const { sheet } of rows) await writeFile(sheetPath(sheet.code, dir), `${JSON.stringify(sheet, null, 2)}\n`);
  return rows.length;
}

const compilePrompt = () => `You turn one Yu-Gi-Oh! card's official text into an effect sheet for a duel engine. Code runs the generic rules (phases, summons, battle, chain, once-per-turn counting); a runtime judge reads your sheet and the card text to apply each effect. Be exact about the card's own wording.

List the card's effects in the order they appear in the text. For each:
- kind: "activation" for activating a Spell/Trap card itself (every Spell/Trap has exactly one, even a Continuous one whose activation does nothing by itself; "effect" then says so); "ignition", "trigger", "quick" or "flip" for activated monster effects; "continuous" for effects that are always on and never activated (including a Spell/Trap's ongoing effect and "this card remains on the field"); "condition" for summoning conditions or procedures. A trigger effect of a Spell/Trap ("When this card leaves the field: destroy ...") is "trigger".
- mandatory: for triggers, true unless the text says "you can". false for everything else.
- opt: "soft" for "once per turn" (or "once per Battle Phase") on this copy, "hard" for "you can only use this effect of <name> once per turn", else "none".
- window: when it can be activated or applies, in plain words, including activation conditions such as "if you control a Synchro Monster". Add no timing the text doesn't state: a Set Normal Trap can be activated on either player's turn.
- cost: the cost exactly as worded (the part before the colon or semicolon that is paid to activate), or "".
- effect: what the effect does, as worded on the card.
- targets: what it targets, as worded, or null if it doesn't target.
- respondsTo: "attack" if it is activated in response to an attack declaration or an attack targeting ("When an opponent's monster declares an attack", "When this card is targeted for an attack"), "summon" if in response to a summon ("When your opponent Normal Summons", "When you Xyz Summon"), "activation" if in response to a card or effect being activated (Counter Traps, "When a monster effect is activated"), else null. Triggers that happen to the card itself ("When this card is Normal Summoned", "If this card is destroyed by battle") are kind "trigger" with respondsTo null.
- script: a JSON string holding the effect as structured data that code runs exactly, with no judge. Write one only when the whole effect, its activation conditions, cost and targets fit the vocabulary below exactly; otherwise null, and a judge applies the text. A script that is almost right is worse than none: code trusts it completely. Only "activation", "ignition" and "quick" effects get scripts; others null.
materials: an Extra Deck monster's materials as worded, else null. Normal Monsters (flavour text) have no effects: return an empty list.

# Scripts

"You" is the player activating the effect. Code already handles phases, once-per-turn clauses, spell speed and respondsTo, so a script says only what the card itself adds.

- conditions: what the board must have for the activation, beyond what the cost, targets and steps need. {"if": "count", "filter": ..., "min": n} needs at least n cards that fit ("While there are 5 or more monsters in your GY", "If you control a Synchro Monster"). {"if": "before_battle_phase"} for "you cannot conduct your Battle Phase the turn you activate this card" (the restriction itself still goes in unapplied).
- cost: steps paid on activation, in order ("Discard 1 card" is a move to graveyard of 1 card chosen from your hand; "Pay 500 LP" is change_lp kind cost; "Tribute this card" is a move of self to graveyard).
- targets: {"filter", "min", "max"} for "target 1 ..." ("up to 3" is min 1 max 3), or null. The player picks them on activation, after paying the cost; resolution steps reach them with {"from": "targets"}, and a target that no longer fits the filter isn't affected.
- options: what the effect does. One option (label "") unless the text says "activate 1 of these effects", then one per bullet with the bullet's wording as label; the player picks one on activation.
- unapplied: a part of the text no step can express, typically a lingering restriction ("You cannot conduct your Battle Phase this turn", "your opponent cannot declare an attack this turn"), in the card's words; the effect resolves without it and says so. Use it only for such a side clause. If the main thing the effect does can't be expressed, the script is null.

Steps (each "cards" is a selection):
- {"do": "destroy", "cards"}: destroy cards on the field.
- {"do": "move", "cards", "to"}: to "hand", "graveyard", "banished", "deck_top", "deck_bottom" or "deck_shuffled". Add to hand, send, discard, banish, return to the Deck.
- {"do": "special_summon", "cards", "position"}: "attack", "defense", or "choice" when the text names no position (the player picks).
- {"do": "modify_stats", "cards", "atk", "def", "levelDelta", "levelSet", "until"}: ATK/DEF deltas, Level delta, or levelSet to make it that Level (else null). until: "end_of_turn" (also "until the End Phase"), "end_of_battle_phase", "next_standby_phase" ("until your next Standby Phase") or "while_on_field" (no end given).
- {"do": "change_lp", "player", "amount", "kind"}: kind "cost", "damage" or "gain"; amount positive.
- {"do": "draw", "player", "count"}.
- {"do": "extra_normal_summon"}: you may conduct one more Normal Summon/Set this turn.

Selections:
- {"from": "self"}: the card being activated.
- {"from": "targets"}: the declared targets.
- {"from": "choose", "filter", "min", "max", "rank"}: the activating player picks min to max cards that fit, when the effect resolves (or when the cost is paid). Use min 0 for "you can". rank {"stat": "atk" | "def" | "level", "order": "lowest" | "highest"} restricts the pick to those tied for that extreme ("the monster with the lowest ATK (your choice, if tied)"), else null. Every choose with min 1 or more must have enough cards that fit for the activation to be legal, which is how "Special Summon 1 ... from your Deck" needs a match in the Deck.
- {"from": "all", "filter"}: every card that fits ("destroy all face-up monsters your opponent controls"); the activation needs at least one.

Filters ({"side", "place", "kinds", "types", "races", "attributes", "faceUp", "position", "level", "atk", "def"}; empty lists and nulls don't restrict):
- side: "you", "opponent" or "either": who controls a card on the field, or whose hand, Deck, GY or banished cards it is in.
- place: "field", "monsters", "spellTraps", "hand", "deck", "graveyard" or "banished".
- kinds: any of "monster", "spell", "trap". "Spell/Trap" is ["spell", "trap"]; "card" is [].
- types: words that must all appear in the card's type line, such as "Synchro", "Xyz", "Tuner", "Normal" (a "non-Effect Monster" is ["Normal"]), "Effect".
- races: any of these monster types ("Warrior", "Spellcaster") or Spell/Trap properties ("Quick-Play", "Continuous").
- attributes: any of "LIGHT", "DARK", "EARTH", "WATER", "FIRE", "WIND", "DIVINE".
- faceUp: true for "face-up", false for "face-down", else null. A face-down card never fits a filter on its type, race, attribute or stats, and fits kinds ["spell", "trap"] only as a pair.
- position: "attack" or "defense", or null.
- level, atk, def: {"min", "max"} with nulls for open ends. Xyz and Link Monsters have no Level, so a filter for cards whose Level an effect changes needs level {"min": 1, "max": null}. "Level 2 or lower" is {"min": null, "max": 2}; "1500 or less ATK" is {"min": null, "max": 1500}. Original ATK isn't expressible: no script.

Examples:
- "Target 1 Warrior-Type monster in your Graveyard; add that target to your hand." conditions [], cost [], targets {"filter": {"side": "you", "place": "graveyard", "kinds": ["monster"], "races": ["Warrior"], ...}, "min": 1, "max": 1}, options [{"label": "", "steps": [{"do": "move", "cards": {"from": "targets"}, "to": "hand"}]}].
- "Discard 1 card; destroy all face-up monsters your opponent controls." cost [{"do": "move", "cards": {"from": "choose", "filter": {"side": "you", "place": "hand", "kinds": [], ...}, "min": 1, "max": 1, "rank": null}, "to": "graveyard"}], options [{"label": "", "steps": [{"do": "destroy", "cards": {"from": "all", "filter": {"side": "opponent", "place": "monsters", "faceUp": true, ...}}}]}].

The script's JSON Schema (every property is required; use null or [] where the text says nothing):
${JSON.stringify(strictSchema(script))}`;

/** Premade-deck cards with text that need a new sheet, or only those named in `names` if any. */
async function cardsToCompile(db: Db, force: boolean, names: string[]) {
  const all = await db.select({ main: decks.main, extra: decks.extra }).from(decks);
  const ids = [...new Set(all.flatMap((d) => [...d.main, ...d.extra]))];
  const rows = ids.length ? await db.select().from(cards).where(inArray(cards.id, ids)) : [];
  const todo = [];
  for (const row of rows) {
    if (row.frameType === 'normal') continue;
    if (names.length && !names.includes(row.name)) continue;
    const sheet = await sheetOf(db, row.id);
    if (sheet?.effects.some((e) => e.status === 'verified')) continue;
    if (!force && sheet?.textHash === row.textHash) continue;
    todo.push(row);
  }
  return todo;
}

export async function compileSheets(db: Db, options: { force?: boolean; names?: string[]; log?: (m: string) => void; client?: Anthropic }) {
  const { force = false, names = [], log = () => {} } = options;
  const todo = await cardsToCompile(db, force, names);
  if (todo.length === 0) return log('Every sheet is up to date.');
  log(`Compiling ${todo.length} effect sheets with ${COMPILE_MODEL}…`);
  const client = options.client ?? new Anthropic();
  const schema = strictSchema(compiled);
  const batch = await client.messages.batches.create({
    requests: todo.map((row) => ({
      custom_id: String(row.id),
      params: {
        model: COMPILE_MODEL,
        max_tokens: 16000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema } },
        system: compilePrompt(),
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
  const usage: ModelUsage[] = [];
  for await (const result of await client.messages.batches.results(batch.id)) {
    const row = byId.get(result.custom_id)!;
    if (result.result.type !== 'succeeded') {
      log(`${row.name}: ${result.result.type}${result.result.type === 'errored' ? ` (${JSON.stringify(result.result.error)})` : ''}`);
      continue;
    }
    usage.push(usageOf(COMPILE_MODEL, result.result.message));
    const text = result.result.message.content.find((b) => b.type === 'text');
    const parsed = text ? compiled.safeParse(JSON.parse(text.text)) : null;
    if (!parsed?.success) {
      log(`${row.name}: the model's sheet didn't parse`);
      continue;
    }
    const effects = parsed.data.effects.map((e, i): SheetEffect => {
      const speed = speedOf(e.kind, row);
      if (e.script === null) return { ...e, speed, script: null, status: 'unverified' };
      const checked = script.safeParse(parseJson(e.script));
      const problem = !checked.success
        ? z.prettifyError(checked.error)
        : !['activation', 'ignition', 'quick'].includes(e.kind)
          ? `a ${e.kind} effect can't have a script`
          : null;
      if (problem) log(`${row.name}: effect ${i}'s script is invalid, so the judge will apply it (${problem})`);
      return { ...e, speed, script: checked.success && !problem ? checked.data : null, status: 'unverified' };
    });
    const sheet: EffectSheet = { code: row.id, textHash: row.textHash, model: COMPILE_MODEL, effects, materials: parsed.data.materials };
    await saveSheet(db, sheet, 'compiled');
    log(`${row.name}: written`);
  }
  // The Batches API charges half the listed prices.
  log(`About $${(costOf(usage) / 2).toFixed(2)}.`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The passcodes of all sheet files. */
export async function listSheetCodes(dir = SHEET_DIR): Promise<number[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => Number(f.slice(0, -5)));
}

if (import.meta.main) {
  const { connect } = await import('./db/client.ts');
  const db = connect(process.env.DATABASE_URL ?? '');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { force: { type: 'boolean', default: false } } });
  const [command, ...names] = positionals;
  if (command === 'compile') await compileSheets(db, { force: values.force, names, log: console.log });
  else if (command === 'import') console.log(`Imported ${await importSheetFiles(db, { force: values.force })} sheets.`);
  else if (command === 'export') console.log(`Exported ${await exportSheetFiles(db)} sheets to ${SHEET_DIR}.`);
  else console.error('Usage: node src/sheets.ts compile|import|export [--force] [card names]');
  await db.$client.end();
}
