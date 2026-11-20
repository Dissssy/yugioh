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
import { DESTINATIONS, FORBIDDEN, RESTRICTIONS, UNTIL, type CardData, type Condition, type Continuous, type ModelUsage, type EffectSheet, type Materials, type Script, type Selection, type SheetEffect, type StatValue, type Step, type When } from '@yugioh/engine';
import type { Db } from './db/client.ts';
import { cards, decks, effectSheets, sheetReports, sheetRevisions } from './db/schema.ts';
import { costOf, usageOf } from './judge/pricing.ts';
import { strictSchema } from './judge/tools.ts';
import { cardFilter } from './judge/cardFilter.ts';

export const SHEET_DIR = fileURLToPath(new URL('../effect-sheets', import.meta.url));
export const COMPILE_MODEL = 'claude-opus-5-5';

export const textHash = (text: string) => createHash('sha256').update(text).digest('hex');


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
  z.object({ from: z.literal('battling'), filter: cardFilter }),
  z.object({ from: z.literal('random'), filter: cardFilter, count: z.number().int().min(1) }),
]) satisfies z.ZodType<Selection>;

const player = z.enum(['you', 'opponent']);
const statValue = z.object({ of: z.enum(['self', 'targets', 'cost']), stat: z.enum(['atk', 'def']), original: z.boolean(), times: z.number() }) satisfies z.ZodType<StatValue>;
const summonKind = z.enum(['normal', 'flip', 'special', 'synchro', 'xyz']);
const phase = z.enum(['draw', 'standby', 'main1', 'battle', 'main2', 'end']);
const step = z.union([
  z.object({ do: z.literal('destroy'), cards: selection }),
  z.object({ do: z.literal('move'), cards: selection, to: z.enum(DESTINATIONS) }),
  z.object({ do: z.literal('special_summon'), cards: selection, position: z.enum(['attack', 'defense', 'choice']), banishWhenLeaves: z.boolean() }),
  z.object({ do: z.literal('arrange_top'), count: z.number().int().min(1), bottom: z.boolean() }),
  z.object({
    do: z.literal('modify_stats'),
    cards: selection,
    atk: z.number().int(),
    def: z.number().int(),
    levelDelta: z.number().int(),
    levelSet: z.number().int().nullable(),
    until: z.enum(UNTIL),
  }),
  z.object({ do: z.literal('set_stats'), cards: selection, atk: statValue.nullable(), def: statValue.nullable(), until: z.enum(UNTIL) }),
  z.object({ do: z.literal('gain_stats'), cards: selection, atk: statValue.nullable(), def: statValue.nullable(), until: z.enum(UNTIL) }),
  z.object({ do: z.literal('change_lp'), player, amount: z.number().int(), kind: z.enum(['cost', 'damage', 'gain']) }),
  z.object({ do: z.literal('draw'), player, count: z.number().int() }),
  z.object({ do: z.literal('extra_normal_summon') }),
  z.object({ do: z.literal('negate_attack') }),
  z.object({ do: z.literal('detach'), cards: selection, count: z.number().int() }),
  z.object({ do: z.literal('take_control'), cards: selection, until: z.literal('end_phase').nullable() }),
  z.object({ do: z.literal('change_position'), cards: selection, position: z.enum(['attack', 'defense', 'switch']) }),
  z.object({
    do: z.literal('summon_token'),
    player,
    token: z.object({ name: z.string(), attribute: z.string(), race: z.string(), level: z.number().int(), atk: z.number().int(), def: z.number().int() }),
    count: z.number().int().min(1),
    position: z.enum(['attack', 'defense', 'choice']),
  }),
  z.object({ do: z.literal('forbid'), player, what: z.enum(FORBIDDEN), filter: cardFilter.nullable() }),
  z.object({ do: z.literal('link'), cards: selection }),
  z.object({ do: z.literal('negate_activation'), destroy: z.boolean() }),
  z.object({ do: z.literal('negate_effects'), cards: selection }),
  z.object({ do: z.literal('set_again') }),
  z.object({ do: z.literal('add_counters'), cards: selection, counter: z.enum(['spell']), count: z.number().int().min(1), max: z.number().int().min(1).nullable() }),
  z.object({ do: z.literal('remove_counters'), cards: selection, counter: z.enum(['spell']), count: z.number().int().min(1) }),
]) satisfies z.ZodType<Step>;

const condition = z.union([
      z.object({ if: z.literal('count'), filter: cardFilter, min: z.number().int(), max: z.number().int().nullable() }),
      z.object({ if: z.literal('turn'), whose: z.enum(['you', 'opponent']) }),
      z.object({ if: z.literal('position'), position: z.enum(['attack', 'defense']) }),
      z.object({ if: z.literal('before_battle_phase') }),
      z.object({ if: z.literal('phase'), phases: z.array(phase) }),
      z.object({ if: z.literal('summoned_this_turn'), how: z.array(summonKind) }),
      z.object({ if: z.literal('materials'), min: z.number().int().nullable(), max: z.number().int().nullable() }),
      z.object({ if: z.literal('outnumbered'), by: z.number().int().min(1) }),
      z.object({ if: z.literal('battling'), as: z.enum(['attacker', 'target']), damageStep: z.boolean() }),
      z.object({ if: z.literal('last_attack'), on: z.enum(['attack', 'defense']) }),
]) satisfies z.ZodType<Condition>;

const script = z.object({
  conditions: z.array(condition),
  cost: z.array(step),
  targets: z.object({ filter: cardFilter, min: z.number().int(), max: z.number().int(), event: z.boolean() }).nullable(),
  options: z.array(z.object({ label: z.string(), cost: z.array(step), steps: z.array(step) })),
  unapplied: z.string().nullable(),
}) satisfies z.ZodType<Script>;

const affected = z.union([z.literal('self'), z.literal('linked'), cardFilter]);
const continuous = z.union([
  z.object({
    apply: z.literal('stats'),
    to: affected,
    atk: z.number().int(),
    def: z.number().int(),
    per: z.union([cardFilter, z.literal('materials')]).nullable(),
    levelDelta: z.number().int(),
    levelSet: z.number().int().nullable(),
    while: z.array(condition),
  }),
  z.object({
    apply: z.literal('restrict'),
    to: affected,
    others: z.boolean(),
    cannot: z.array(z.enum(RESTRICTIONS)),
    by: cardFilter.nullable(),
    compare: z.object({ stat: z.enum(['atk', 'def']), self: z.enum(['atk', 'def']) }).nullable(),
    once: z.boolean(),
    while: z.array(condition),
  }),
  z.object({ apply: z.literal('battle'), to: affected, attacks: z.number().int().min(1).max(3), piercing: z.boolean(), noDamageToYou: z.boolean(), while: z.array(condition) }),
  z.object({
    apply: z.literal('lock'),
    player: z.enum(['you', 'opponent', 'both']),
    cannot: z.enum(['activate', 'tribute_summon']),
    filter: cardFilter.nullable(),
    perTurn: z.number().int().min(1).nullable(),
    setFirst: z.boolean(),
    while: z.array(condition),
  }),
  z.object({ apply: z.literal('negate_linked') }),
  z.object({ apply: z.literal('name'), name: z.string().min(1) }),
  z.object({ apply: z.literal('synchro_material'), substitutes: z.string().nullable(), never: z.boolean(), onlyFor: cardFilter.nullable(), onlyForTuner: z.string().nullable() }),
  z.object({ apply: z.literal('self_destruct'), opponentTurns: z.number().int().min(1) }),
  z.object({ apply: z.literal('tie'), destroyLinked: z.boolean(), defenseBreaks: z.boolean() }),
  z.object({ apply: z.literal('replace_destruction'), detach: z.number().int().min(1) }),
]) satisfies z.ZodType<Continuous>;

const when = z.object({
  event: z.enum(['summoned', 'attack_declared', 'attacked', 'destroyed_by_battle', 'destroyed_by_effect', 'battle_destroying', 'battle_damage', 'activated', 'damage_step_start', 'end_phase', 'sent_to_graveyard']),
  self: z.boolean(),
  filter: cardFilter.nullable(),
  how: z.array(summonKind),
  canMiss: z.boolean(),
  by: z.enum(['you', 'opponent']).nullable(),
}) satisfies z.ZodType<When>;

const materials = z.union([
  z.object({ summon: z.literal('synchro'), tuner: z.string().nullable(), nonTuners: z.object({ min: z.number().int().min(1), max: z.number().int().min(1).nullable() }) }),
  z.object({ summon: z.literal('xyz'), level: z.number().int().min(1), count: z.number().int().min(2) }),
]) satisfies z.ZodType<Materials>;

const sheetEffect = z.object({
  kind: z.enum(['activation', 'ignition', 'trigger', 'quick', 'continuous', 'flip', 'condition']),
  speed: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  mandatory: z.boolean(),
  from: z.enum(['field', 'hand', 'graveyard']),
  opt: z.enum(['none', 'soft', 'hard']),
  window: z.string(),
  cost: z.string(),
  effect: z.string(),
  targets: z.string().nullable(),
  when: when.nullable(),
  script: script.nullable(),
  continuous: continuous.nullable(),
  status: z.enum(['unverified', 'verified', 'flagged']),
}) satisfies z.ZodType<SheetEffect>;

/**
 * What the compiling model returns for one card. Each `when` and script comes back as JSON text and is checked here:
 * their schemas have more unions than structured outputs accept.
 */
const compiled = z.object({
  effects: z.array(sheetEffect.omit({ speed: true, status: true }).extend({ when: z.string().nullable(), script: z.string().nullable(), continuous: z.string().nullable() })),
  materials: z.string().nullable(),
  normalSummon: z.boolean(),
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
  materials: materials.nullable(),
  normalSummon: z.boolean(),
}) satisfies z.ZodType<EffectSheet>;

/** Sheets for the given cards, keyed by passcode. A card without a current sheet acts as if it had no effects. */
export async function loadSheets(db: Db, cardData: Record<number, CardData>): Promise<Record<number, EffectSheet>> {
  const codes = Object.keys(cardData).map(Number);
  const rows = codes.length ? await db.select().from(effectSheets).where(inArray(effectSheets.code, codes)) : [];
  return current(cardData, rows.flatMap((r) => stored(r.sheet) ?? []));
}

/**
 * A stored sheet as the current schema reads it, or null if it was written in an older shape (one from before a
 * field like `when` existed). Such a sheet is never played: the next card sync replaces it from the files.
 */
function stored(sheet: unknown): EffectSheet | null {
  const parsed = sheetSchema.safeParse(sheet);
  if (parsed.success) return parsed.data;
  console.warn(`Effect sheet ${(sheet as { code?: unknown }).code} is in an old format; the next card sync replaces it from server/effect-sheets/.`);
  return null;
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
  const row = await db.query.effectSheets.findFirst({ where: eq(effectSheets.code, code) });
  return row ? stored(row.sheet) : null;
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

/**
 * Loads the sheet files into the database: those it lacks or holds only in an older format, or with `force` all of
 * them. Returns how many.
 */
export async function importSheetFiles(db: Db, options: { dir?: string; force?: boolean } = {}): Promise<number> {
  const { dir = SHEET_DIR, force = false } = options;
  const codes = await listSheetCodes(dir);
  const rows = codes.length ? await db.select().from(cards).where(inArray(cards.id, codes)) : [];
  const files = await readSheetFiles(Object.fromEntries(rows.map((r) => [r.id, { code: r.id, name: r.name, text: r.text } as CardData])), dir);
  const have = new Set((await db.select().from(effectSheets)).filter((r) => sheetSchema.safeParse(r.sheet).success).map((r) => r.code));
  let n = 0;
  for (const sheet of Object.values(files)) {
    if (!force && have.has(sheet.code)) continue;
    await saveSheet(db, sheet, 'imported');
    n++;
  }
  return n;
}

/**
 * Deletes every stored sheet, revision and report, so the next card sync loads the files afresh (`RESET_SHEETS`).
 * Duels keep the sheets they started with in their logs.
 */
export async function resetSheets(db: Db): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(sheetReports);
    await tx.delete(sheetRevisions);
    await tx.delete(effectSheets);
  });
}

/** Writes every sheet in the database to `dir`, one file per card. */
export async function exportSheetFiles(db: Db, dir = SHEET_DIR): Promise<number> {
  const rows = await db.select().from(effectSheets);
  // Parsed, so the keys come out in the schema's order rather than the database's.
  for (const { sheet } of rows) await writeFile(sheetPath(sheet.code, dir), `${JSON.stringify(sheetSchema.parse(sheet), null, 2)}\n`);
  return rows.length;
}

const compilePrompt = () => `You turn one Yu-Gi-Oh! card's official text into an effect sheet for a duel engine. Code runs the generic rules (phases, summons, battle, chain, once-per-turn counting); a runtime judge reads your sheet and the card text to apply each effect. Be exact about the card's own wording.

List the card's effects in the order they appear in the text. For each:
- kind: "activation" for activating a Spell/Trap card itself (every Spell/Trap has exactly one, even a Continuous one whose activation does nothing by itself; "effect" then says so); "ignition", "trigger", "quick" or "flip" for activated monster effects; "continuous" for effects that are always on and never activated (including a Spell/Trap's ongoing effect and "this card remains on the field"); "condition" for summoning conditions or procedures. A trigger effect of a Spell/Trap ("When this card leaves the field: destroy ...") is "trigger".
- mandatory: for triggers and FLIP effects, true unless the text says "you can". false for everything else.
- from: for a monster's trigger, ignition or quick effect, where this card is when it is used: "field" (face-up on the field), "hand" ("If you control an "Ice Barrier" monster: You can Special Summon this card from your hand" is an ignition effect from "hand") or "graveyard" ("You can banish this card from your GY; ...", "When this card is destroyed by battle and sent to the GY"). "field" for everything else.
- opt: "soft" for "once per turn" (or "once per Battle Phase") on this copy, "hard" for "you can only use this effect of <name> once per turn", else "none".
- window: when it can be activated or applies, in plain words, including activation conditions such as "if you control a Synchro Monster". Add no timing the text doesn't state: a Set Normal Trap can be activated on either player's turn.
- cost: the cost exactly as worded (the part before the colon or semicolon that is paid to activate), or "".
- effect: what the effect does, as worded on the card.
- targets: what it targets, as worded, or null if it doesn't target.
- when: a JSON string naming the event the effect needs, as data code checks (see "When" below), or null. Every trigger has one: it is what makes the trigger fire ("When this card is Normal Summoned", "If this card is destroyed by battle"). A Spell/Trap or quick effect that is activated in response to an event has one too ("When an opponent's monster declares an attack", "When your opponent Normal Summons a monster"). Effects that need no event have null, and so do FLIP effects: code fires them when the card is flipped face-up, even if it then left the field.
- continuous: for a "continuous" effect, a JSON string with what it does as data code applies at all times (see "Continuous effects" below), or null when it doesn't fit that vocabulary exactly (a judge can't apply an always-on effect, so it then does nothing until someone writes it). null for every other kind.
- script: a JSON string holding the effect as structured data that code runs exactly, with no judge. Write one only when the whole effect, its activation conditions, cost and targets fit the vocabulary below exactly; otherwise null, and a judge applies the text. A script that is almost right is worse than none: code trusts it completely. Only "activation", "ignition", "quick" and "trigger" effects get scripts, and "condition" effects that are Summoning procedures from the hand (see "Summoning procedures" below); others null.
normalSummon: false when the text says the card "cannot be Normal Summoned/Set" (in any wording), else true.
materials: a JSON string with an Extra Deck monster's materials as data code checks, else null. A Synchro Monster: {"summon": "synchro", "tuner": null, "nonTuners": {"min": 1, "max": null}} for "1 Tuner + 1 or more non-Tuner monsters"; "tuner" is the Tuner's name when the text names one ("Junk Synchron" + ...), and nonTuners gives how many ("1 or more" is min 1, max null; "2 non-Tuner monsters" is min 2, max 2). An Xyz Monster: {"summon": "xyz", "level": 4, "count": 2} for "2 Level 4 monsters". Normal Monsters (flavour text) have no effects: return an empty list.

# Scripts

"You" is the player activating the effect. Code already handles phases, once-per-turn clauses, spell speed and the event in "when", so a script says only what the card itself adds.

- conditions: what the board must have for the activation, beyond what the cost, targets and steps need. {"if": "count", "filter": ..., "min": n, "max": n | null} needs at least min and at most max cards that fit ("While there are 5 or more monsters in your GY": min 5, max null; "If you control a Synchro Monster": min 1; "while you have 1 or less cards in your hand": min 0, max 1). This card itself is never counted, so "If you control another "Ice Barrier" monster" is min 1, in a script and in a continuous effect's "while" alike. {"if": "turn", "whose": "you" | "opponent"} for "during your turn" ("during your Battle Phase" is this plus a phase condition). {"if": "position", "position": "attack" | "defense"} for "while this card is in face-up Defense Position". {"if": "before_battle_phase"} for "you cannot conduct your Battle Phase the turn you activate this card" (the restriction itself still goes in unapplied). {"if": "phase", "phases": [...]} when the text names the phases it is used in ("during the Battle Phase": ["battle"]); an ignition effect with this condition is used in those phases instead of the Main Phase. {"if": "summoned_this_turn", "how": [...]} for "if this card was Normal Summoned this turn" (how: any of "normal", "flip", "special", "synchro", "xyz"; "special" also covers Synchro and Xyz Summons; [] for any Summon). {"if": "materials", "min": n | null, "max": n | null} needs this Xyz Monster to have that many Xyz Materials ("while this card has no Xyz Material": min null, max 0). {"if": "outnumbered", "by": n} for "If your opponent controls n or more cards than you do" (cards on the field). {"if": "battling", "as": "attacker" | "target", "damageStep": bool} while this card is attacking an opponent's monster ("attacker") or is the attack's target ("target"), only in the Damage Step if damageStep ("during the Damage Step only"). {"if": "last_attack", "on": "attack" | "defense"} if this card's last attack this turn was on a monster in that position.
- cost: steps paid on activation, in order ("Discard 1 card" is a move to graveyard of 1 card chosen from your hand; "Pay 500 LP" is change_lp kind cost; "Tribute this card" is a move of self to graveyard).
- targets: {"filter", "min", "max", "event"} for "target 1 ..." ("up to 3" is min 1 max 3), or null. The player picks them on activation, after paying the cost; resolution steps reach them with {"from": "targets"}, and a target that no longer fits the filter isn't affected. event true for "target that monster", where the target is the card the "when" event happened to (Trap Hole); else false.
- options: what the effect does. One option (label "") unless the text says "activate 1 of these effects", then one per bullet with the bullet's wording as label; the player picks one on activation. Each option has its own cost, paid after the script's cost once the option is picked: a cost only one bullet has ("● Tribute 1 monster, then target ...") goes there; else [].
- unapplied: a part of the text no step can express, typically a lingering restriction ("You cannot conduct your Battle Phase this turn", "your opponent cannot declare an attack this turn"), in the card's words; the effect resolves without it and says so. Use it only for such a side clause. If the main thing the effect does can't be expressed, the script is null.

# Summoning procedures

"You can Special Summon this card (from your hand) by ...", "If you control ..., you can Special Summon this card (from your hand)", "Must be Special Summoned (from your hand) by ...": a "condition" effect whose script code runs as a Summoning procedure. It is used in its controller's Main Phase while the card is in the hand, and doesn't start a chain or use the once-per-turn of other effects. conditions: what must hold ("If you control a WATER monster": a count condition; "by having exactly 5 WATER monsters in your GY": count min 5, max 5). cost: what the Summon is made "by" ("by sending 1 monster from your hand to the GY": a move to graveyard of 1 monster chosen from your hand; "by Tributing 1 Warrior monster": a move to graveyard of 1 face-up Warrior monster you control; "by banishing 1 WATER monster from your GY": a move to banished). targets null. options: one option whose first step is {"do": "special_summon", "cards": {"from": "self"}, "position": "choice"}, followed by what else the text says comes with it ("and if you do, it gains ATK equal to the Tributed monster's original ATK": gain_stats with {"of": "cost", ...}; "but you cannot Special Summon monsters from your hand for the rest of this turn": forbid special_summon). "Cannot be Normal Summoned/Set" alone is a condition effect with no script (and normalSummon false); when it shares a sentence with the procedure, one condition effect has both. A procedure from anywhere but the hand, or one this vocabulary can't express, has no script.

# Continuous effects

{"apply": "stats", "to", "atk", "def", "per", "levelDelta", "levelSet", "while"}: while this card is face-up on the field and every "while" condition holds (the conditions above, with "you" as this card's controller), the monsters in "to" gain atk and def (negative for a loss) and their Level changes by levelDelta, or becomes levelSet (else null). "to" is "self", "linked" (the monster this card is equipped or tied to: "the equipped monster", a Continuous Trap's "that monster"), or a filter of the face-up monsters it applies to. "per" multiplies atk and def: null for a flat amount, a filter to count cards ("for each face-up Level 2 monster you control", counting this card too if it fits), or "materials" for "for each Xyz Material attached to this card". Examples: "All monsters you control gain 200 ATK during your Battle Phase only": to {"side": "you", "place": "monsters", "faceUp": true, ...}, atk 200, while [{"if": "turn", "whose": "you"}, {"if": "phase", "phases": ["battle"]}]. "This card is Level 4 while in face-up Defense Position": to "self", levelSet 4, while [{"if": "position", "position": "defense"}].

{"apply": "restrict", "to", "others", "cannot", "by", "compare", "once", "while"}: the cards in "to" can't do what "cannot" lists: "attack" (declare an attack), "change_position", "be_attacked" (be targeted for an attack), "be_destroyed_by_battle", "be_destroyed_by_effect" (by a card effect), "be_affected" (unaffected by activated card effects). others true leaves this card itself out ("except this one"). by: for be_destroyed_by_battle, a filter the monster it battles must fit ("with a monster that has 1900 or more ATK": atk {"min": 1900, "max": null}); for be_destroyed_by_effect and be_affected, a filter the card whose effect it is must fit ("cannot be destroyed by Spell or Trap Card effects": kinds ["spell", "trap"], place "any"; "unaffected by the activated effects of your opponent's monsters that were Special Summoned from the Extra Deck": side "opponent", place "any", kinds ["monster"], extraDeck true); else null. compare {"stat", "self"}: only cards in "to" whose stat is at least this card's ("monsters your opponent controls cannot declare an attack if their ATK is greater than or equal to this card's DEF": stat "atk", self "def"), else null. once true for "Once per turn, this card cannot be destroyed by battle" (the first time each turn only). Monster conditions like "Level 4 or higher monsters cannot declare an attack" go in the "to" filter (side "either", level {"min": 4, "max": null}). "Your opponent's monsters cannot declare an attack": to {"side": "opponent", "place": "monsters", ...}, cannot ["attack"]. "Your opponent cannot target Warrior monsters for attacks, except this one": to {"side": "you", "place": "monsters", "faceUp": true, "races": ["Warrior"], ...}, others true, cannot ["be_attacked"].

{"apply": "battle", "to", "attacks", "piercing", "noDamageToYou", "while"}: the monsters in "to" can make "attacks" attacks each Battle Phase (2 for "can make a second attack during each Battle Phase", else 1), inflict piercing battle damage when attacking a Defense Position monster (piercing), and their controller takes no battle damage from attacks involving them ("You take no battle damage from attacks involving this card": noDamageToYou). "Once per Battle Phase, if this card attacks a Defense Position monster, it can make a second attack in a row": to "self", attacks 2, while [{"if": "last_attack", "on": "defense"}].

{"apply": "lock", "player", "cannot", "filter", "perTurn", "setFirst", "while"}: a player-wide lock. player "you", "opponent" or "both". cannot "activate": that player can't activate the cards that fit filter (null for any card; "you" in it is this card's controller): "Effects of monsters in the hand cannot be activated": player "both", filter side "either", place "hand", kinds ["monster"]. perTurn n: they can activate at most n such cards each turn instead ("Your opponent can only activate 1 Spell/Trap Card each turn": player "opponent", kinds ["spell", "trap"], place "any", perTurn 1). setFirst true: they can activate such cards only once Set on an earlier turn ("both players must Set Spell Cards before activating them, and cannot activate them until their next turn": player "both", kinds ["spell"], place "any", setFirst true). cannot "tribute_summon" ("your opponent cannot Tribute Summon"): filter null, perTurn null, setFirst false.

{"apply": "negate_linked"}: "negate the effects of that face-up monster" for a card linked to a monster (Fiendish Chain).

{"apply": "name", "name"}: "This card's name becomes "Des Frog" while it is on the field" (name "Des Frog").

{"apply": "synchro_material", "substitutes", "never", "onlyFor", "onlyForTuner"}: this card as Synchro Material. substitutes: "For a Synchro Summon, you can substitute this card for any 1 "Synchron" Tuner" is "Synchron", else null. never true for "Cannot be used as a Synchro Material". onlyFor: a filter the Synchro Monster must fit ("cannot be used as a Synchro Material Monster, except for the Synchro Summon of a WATER monster": side "either", place "any", attributes ["WATER"]), else null. onlyForTuner: "except for the Synchro Summon of a monster that lists a "Synchron" Tuner as material" is "Synchron", else null.

{"apply": "tie", "destroyLinked", "defenseBreaks"}: for an Equip Spell or Continuous Trap linked to a monster (see the link step). Code always destroys a linked card when its monster leaves the field, so "When that monster is destroyed, destroy this card" needs only this entry with both false. destroyLinked true for "When this card leaves the field, destroy that monster"; defenseBreaks true for "If the target is changed to Defense Position, destroy it and this card". Write these as kind "continuous" even when worded "When ...".
{"apply": "replace_destruction", "detach"}: "If this face-up card would be destroyed, you can detach 1 Xyz Material from this card instead" (detach 1). Code asks its controller each time it would be destroyed, by battle or by an effect.

{"apply": "self_destruct", "opponentTurns": n}: "this card remains on the field, but destroy it during the End Phase of your opponent's nth turn" (a Normal Spell/Trap with this stays on the field after it resolves).

Steps (each "cards" is a selection):
- {"do": "destroy", "cards"}: destroy cards on the field.
- {"do": "move", "cards", "to"}: to "hand", "graveyard", "banished", "deck_top", "deck_bottom" or "deck_shuffled". Add to hand, send, discard, banish, return to the Deck.
- {"do": "special_summon", "cards", "position", "banishWhenLeaves"}: "attack", "defense", or "choice" when the text names no position (the player picks). banishWhenLeaves true for "but banish it when it leaves the field" / "If you do, banish it when it leaves the field".
- {"do": "arrange_top", "count", "bottom"}: the activating player looks at the top count cards of their own Deck and puts each back on top, or on the bottom if bottom is true ("look at the top card of your Deck. Return that card to either the top or the bottom of the Deck": count 1, bottom true). Looking at the opponent's Deck can't be scripted.
- {"do": "modify_stats", "cards", "atk", "def", "levelDelta", "levelSet", "until"}: ATK/DEF deltas, Level delta, or levelSet to make it that Level (else null). until: "end_of_turn" (also "until the End Phase"), "end_of_battle_phase", "next_standby_phase" ("until your next Standby Phase") or "while_on_field" (no end given).
- {"do": "set_stats", "cards", "atk", "def", "until"}: ATK and/or DEF "become" a value (null leaves that stat alone). Each value is {"of": "self" | "targets" | "cost", "stat": "atk" | "def", "original": bool, "times": n}: a stat read when the effect resolves from this card, its first target or the first card paid as its cost, the printed ("original") or current value, multiplied by times. "Make its ATK become double its original ATK": {"of": "self", "stat": "atk", "original": true, "times": 2}. "This card's ATK/DEF become equal to that monster's original ATK/DEF": atk {"of": "targets", "stat": "atk", "original": true, "times": 1}, def likewise.
- {"do": "gain_stats", "cards", "atk", "def", "until"}: ATK and/or DEF gain a value read when the step resolves (each a value as in set_stats, or null). "It gains ATK equal to the Tributed monster's original ATK" (in a procedure whose cost Tributed it): atk {"of": "cost", "stat": "atk", "original": true, "times": 1}, def null, until "while_on_field".
- {"do": "change_lp", "player", "amount", "kind"}: kind "cost", "damage" or "gain"; amount positive.
- {"do": "draw", "player", "count"}.
- {"do": "extra_normal_summon"}: you may conduct one more Normal Summon/Set this turn.
- {"do": "negate_attack"}: "negate the attack"; the attack ends with no damage.
- {"do": "negate_activation", "destroy"}: "negate the activation" of what this effect answers (its when is "activated"); destroy true for "and if you do, destroy it" or "destroy that monster".
- {"do": "negate_effects", "cards"}: "but it has its effects negated" / "their effects are negated" on the monsters selected (after a special_summon of the targets, {"from": "targets"} still reaches them).
- {"do": "set_again"}: "Set this card face-down instead of sending it to the GY".
- {"do": "add_counters", "cards", "counter", "count", "max"}: "place 1 Spell Counter on it (max. 1)": counter "spell", max 1 (null for no limit).
- {"do": "remove_counters", "cards", "counter", "count"}: "remove 1 Spell Counter from this card", usually in cost.
- {"do": "link", "cards"}: equip this card to the monster the selection picks ("Equip this card to 1 face-up monster": targets that monster, then link {"from": "targets"}), or tie a Continuous Trap to its target or to the monster it Special Summoned (special_summon {"from": "targets"}, then link {"from": "targets"}). An Equip Spell or a Continuous Trap that works through its monster goes to the GY if it resolves without being linked.
- {"do": "change_position", "cards", "position"}: change the battle position of the monsters selected to "attack" or "defense", or "switch" for "change its battle position". A face-down monster turns face-up.
- {"do": "take_control", "cards", "until"}: you take control of the monsters selected (usually {"from": "targets"}): until "end_phase" for "until the End Phase", null for good ("take control of that monster"). It needs a free Monster Zone of yours.
- {"do": "summon_token", "player", "token", "count", "position"}: Special Summon count Tokens to that player's field. token {"name", "attribute", "race", "level", "atk", "def"} from the text: "1 "Ice Barrier Token" (Aqua/WATER/Level 1/ATK 0/DEF 0)" is {"name": "Ice Barrier Token", "attribute": "WATER", "race": "Aqua", "level": 1, "atk": 0, "def": 0}.
- {"do": "forbid", "player", "what", "filter"}: for the rest of this turn that player can't "declare_attack" ("your opponent cannot declare an attack this turn"), can't conduct their "battle_phase" ("you cannot conduct your Battle Phase the turn you activate this card"; pair it with the before_battle_phase condition), or can't "special_summon" the monsters that fit filter ("you cannot Special Summon monsters from your hand for the rest of this turn": side "you", place "hand", kinds ["monster"]; "You cannot Special Summon any Level 5 or higher monsters the turn you use this effect": place "any", level min 5; null for any monster). filter is null for the other two. Such a restriction is a step, not unapplied.
- {"do": "detach", "cards", "count"}: detach count Xyz Materials from an Xyz Monster the selection picks. "Detach 1 Xyz Material from this card" (usually a cost): cards {"from": "self"}, count 1. "Detach 1 Xyz Material from a monster you control": a choose selection of face-up Xyz monsters you control.

Selections:
- {"from": "self"}: the card being activated.
- {"from": "targets"}: the declared targets.
- {"from": "choose", "filter", "min", "max", "rank"}: the activating player picks min to max cards that fit, when the effect resolves (or when the cost is paid). Use min 0 for "you can". rank {"stat": "atk" | "def" | "level", "order": "lowest" | "highest"} restricts the pick to those tied for that extreme ("the monster with the lowest ATK (your choice, if tied)"), else null. Every choose with min 1 or more must have enough cards that fit for the activation to be legal, which is how "Special Summon 1 ... from your Deck" needs a match in the Deck.
- {"from": "battling", "filter"}: the monster battling this card, if it fits ("if this card attacks a face-up Defense Position monster: destroy that monster" is a destroy step on {"from": "battling"} with faceUp true, position "defense"; the effect doesn't fire without one).
- {"from": "random", "filter", "count"}: count cards that fit, picked at random by code, or all of them if fewer fit ("Discard 2 random cards from your opponent's hand (or their entire hand, if less than 2)": filter side "opponent", place "hand", count 2; "place 1 random card from their hand on top of their Deck": a move of count 1 to deck_top). The effect needs at least one.
- {"from": "all", "filter"}: every card that fits ("destroy all face-up monsters your opponent controls"); the activation needs at least one.

Filters ({"side", "place", "kinds", "types", "races", "attributes", "named", "extraDeck", "faceUp", "position", "level", "atk", "def"}; empty lists and nulls don't restrict):
- side: "you", "opponent" or "either": who controls a card on the field, or whose hand, Deck, GY or banished cards it is in.
- place: "field", "monsters", "spellTraps", "hand", "deck", "graveyard", "banished", or "any" (wherever it is: "When a monster effect is activated" matches one activated from the hand or GY too).
- kinds: any of "monster", "spell", "trap". "Spell/Trap" is ["spell", "trap"]; "card" is [].
- types: words that must all appear in the card's type line, such as "Synchro", "Xyz", "Tuner", "Normal" (a "non-Effect Monster" is ["Normal"]), "Effect".
- races: any of these monster types ("Warrior", "Spellcaster") or Spell/Trap properties ("Quick-Play", "Continuous").
- attributes: any of "LIGHT", "DARK", "EARTH", "WATER", "FIRE", "WIND", "DIVINE".
- named: text the card's name must contain, for an archetype or a named card: "Ice Barrier" for an "Ice Barrier" monster, "Synchron" for a "Synchron" monster; else null.
- extraDeck: true for a monster that belongs in the Extra Deck (Fusion, Synchro, Xyz; "Special Summoned from the Extra Deck" for one on the field), false for a Main Deck monster, else null.
- faceUp: true for "face-up", false for "face-down", else null. A face-down card never fits a filter on its type, race, attribute or stats, and fits kinds ["spell", "trap"] only as a pair.
- position: "attack" or "defense", or null.
- level, atk, def: {"min", "max"} with nulls for open ends. Xyz and Link Monsters have no Level, so a filter for cards whose Level an effect changes needs level {"min": 1, "max": null}. "Level 2 or lower" is {"min": null, "max": 2}; "1500 or less ATK" is {"min": null, "max": 1500}. A filter can't test original ATK.

# When

{"event", "self", "filter", "how", "canMiss", "by"}, every property required:
- event: "summoned" (a monster is Summoned), "attack_declared" (a monster declares an attack; the event's card is the attacker), "attacked" (a monster is targeted for an attack: "When this card is targeted for an attack"; the event's card is the target), "destroyed_by_battle", "battle_destroying" (a monster destroys another by battle: "When this card destroys a monster by battle"; the event's card is the destroyer, so self is true), "battle_damage" (a monster inflicts battle damage to its controller's opponent),, "activated" (a card or effect is activated: "When a Trap Card is activated", "When a monster effect is activated"; the event's card is the one whose activation it is, and the filter says which: kinds ["trap"], or kinds ["monster"] with place "any"), "destroyed_by_effect" (a card on the field is destroyed by a card effect: "If this face-up card is destroyed by your opponent's card effect"; the filter is checked as the card was on the field, only its side and faceUp), "damage_step_start" (the start of the Damage Step; the event's card is the attacker, so "if this card attacks" is self true), "end_phase" (the End Phase starts: "During the End Phase"; self false, filter null; "of the turn this card was Summoned" is a summoned_this_turn condition) or "sent_to_graveyard" (a card goes from the field to the GY by any means: "When this card you control is sent to the Graveyard", "When this card is sent from the field to the Graveyard"; the effect's from is "graveyard"). An event outside this list (sent to the GY from the hand or Deck, flipped, targeted, leaves the field): when null, and the effect never fires; say so in its window.
- self: true when it must happen to this card ("When this card is Normal Summoned", "If this card inflicts battle damage").
- filter: the card it happens to must fit this filter (with self, for "When this face-up Attack Position card is targeted for an attack": faceUp true, position "attack") as it is after the event ("When your opponent Normal Summons a monster with 1000 or more ATK": side "opponent", place "monsters", atk {"min": 1000, "max": null}; "When an opponent's monster declares an attack": side "opponent", place "monsters"); null for any card. "you" and "opponent" are from this card's controller's view.
- how: for "summoned", which Summons count: any of "normal" (a Tribute Summon is one), "flip", "special" (any Special Summon, Synchro and Xyz Summons included), "synchro", "xyz"; [] for "Summoned" with no kind. "If this card is Synchro Summoned" is ["synchro"].
- by: for "destroyed_by_effect", whose card effect it must be: "you", "opponent" ("by your opponent's card effect"), or null for anyone's. null for other events.
- canMiss: true only for an optional trigger worded "When ...: You can" (it misses the timing unless its event was the last thing to happen); false for "If ..." and for mandatory triggers.

Examples:
- "Target 1 Warrior-Type monster in your Graveyard; add that target to your hand." conditions [], cost [], targets {"filter": {"side": "you", "place": "graveyard", "kinds": ["monster"], "races": ["Warrior"], ...}, "min": 1, "max": 1, "event": false}, options [{"label": "", "steps": [{"do": "move", "cards": {"from": "targets"}, "to": "hand"}]}].
- Magna Drago, "If this card inflicts battle damage to your opponent: It gains 200 ATK.": kind "trigger", mandatory true, when {"event": "battle_damage", "self": true, "filter": null, "how": [], "canMiss": false}, script options [{"label": "", "steps": [{"do": "modify_stats", "cards": {"from": "self"}, "atk": 200, "def": 0, "levelDelta": 0, "levelSet": null, "until": "while_on_field"}]}].
- "Discard 1 card; destroy all face-up monsters your opponent controls." cost [{"do": "move", "cards": {"from": "choose", "filter": {"side": "you", "place": "hand", "kinds": [], ...}, "min": 1, "max": 1, "rank": null}, "to": "graveyard"}], options [{"label": "", "steps": [{"do": "destroy", "cards": {"from": "all", "filter": {"side": "opponent", "place": "monsters", "faceUp": true, ...}}}]}].

The script's JSON Schema (every property is required; use null or [] where the text says nothing):
${JSON.stringify(strictSchema(script))}

The "when" JSON Schema:
${JSON.stringify(strictSchema(when))}`;

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
      // A trigger without a readable event would never fire, so its whole sheet entry is kept but logged.
      const whenChecked = e.when === null ? null : when.safeParse(parseJson(e.when));
      if (whenChecked && !whenChecked.success) log(`${row.name}: effect ${i}'s when is invalid (${z.prettifyError(whenChecked.error)})`);
      const continuousChecked = e.continuous === null ? null : continuous.safeParse(parseJson(e.continuous));
      const continuousProblem = !continuousChecked ? null : !continuousChecked.success ? z.prettifyError(continuousChecked.error) : e.kind !== 'continuous' ? `a ${e.kind} effect can't have a continuous part` : null;
      if (continuousProblem) log(`${row.name}: effect ${i}'s continuous part is invalid, so it does nothing (${continuousProblem})`);
      const base = {
        ...e,
        speed,
        when: whenChecked?.success ? whenChecked.data : null,
        continuous: continuousChecked?.success && !continuousProblem ? continuousChecked.data : null,
        status: 'unverified' as const,
      };
      if (e.script === null) return { ...base, script: null };
      const checked = script.safeParse(parseJson(e.script));
      const problem = !checked.success
        ? z.prettifyError(checked.error)
        : !['activation', 'ignition', 'quick', 'trigger', 'condition'].includes(e.kind)
          ? `a ${e.kind} effect can't have a script`
          : null;
      if (problem) log(`${row.name}: effect ${i}'s script is invalid, so the judge will apply it (${problem})`);
      return { ...base, script: checked.success && !problem ? checked.data : null };
    });
    const materialsChecked = parsed.data.materials === null ? null : materials.safeParse(parseJson(parsed.data.materials));
    if (materialsChecked && !materialsChecked.success) log(`${row.name}: its materials are invalid, so it can't be Summoned (${z.prettifyError(materialsChecked.error)})`);
    const sheet: EffectSheet = {
      code: row.id,
      textHash: row.textHash,
      model: COMPILE_MODEL,
      effects,
      materials: materialsChecked?.success ? materialsChecked.data : null,
      normalSummon: parsed.data.normalSummon,
    };
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
