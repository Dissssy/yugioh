// The judge's tools: one per op, plus ask_player and finish. The same Zod schemas give the tool definitions sent to
// Claude and the runtime check of each call. Tools are strict, so every call parses, except those marked `loose`. The
// API allows 20 strict tools and 16 union-typed (nullable or anyOf) parameters across them, so tools with a card ID or
// two and little else, and forbid with its many-nullable card filter, go without (parseOp still checks them). A test
// holds both limits.

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { DESTINATIONS, FORBIDDEN, UNTIL, type Op } from '@yugioh/engine';
import { cardFilter } from './cardFilter.ts';

const card = z.string().describe('A card instance ID from the state, such as "k3f9a0b2".');
const seat = z.literal([0, 1]).describe('Player 0 or player 1.');
const position = z.enum(['attack', 'defense']);

export const opTools = {
  move: {
    description:
      'Move a card to the hand, Deck, GY or banished, from wherever it is: add to hand, send to GY, banish, return to Deck. Cards go to their owner\'s pile; Extra Deck monsters sent to the hand or Deck return to the Extra Deck. Moving a card out of the Deck (other than the top card) shuffles the Deck automatically. Not for drawing (use draw) or destroying (use destroy).',
    input: z.object({ card, to: z.enum(DESTINATIONS) }),
  },
  special_summon: {
    description:
      'Special Summon a monster face-up from the hand, Deck, GY, banished or, when the text says so, the Extra Deck. Its controller is asked which empty Main Monster Zone it goes to. banish_when_leaves: true for "but banish it when it leaves the field".',
    input: z.object({ card, controller: seat, position, banish_when_leaves: z.boolean() }),
  },
  take_control: {
    loose: true,
    description:
      'Take control of a monster on the field for `controller` ("take control of that target until the End Phase"). until: "end_phase" when it goes back to its owner as the End Phase starts, null for good. Its new controller is asked which empty Main Monster Zone it goes to.',
    input: z.object({ card, controller: seat, until: z.literal('end_phase').nullable() }),
  },
  summon_token: {
    description:
      'Special Summon one Token to a player\'s field, with the stats the text gives ("Ice Barrier Token" (Aqua/WATER/Level 1/ATK 0/DEF 0)). One call per Token. Its controller is asked which empty Main Monster Zone it goes to. A Token that leaves the field is gone.',
    input: z.object({
      controller: seat,
      token: z.object({ name: z.string(), attribute: z.string(), race: z.string(), level: z.number().int(), atk: z.number().int(), def: z.number().int() }),
      position,
    }),
  },
  destroy: {
    description: 'Destroy cards on the field; they go to their owners\' GYs.',
    input: z.object({ cards: z.array(card) }),
  },
  change_lp: {
    description: 'Change a player\'s LP. amount is positive. kind "cost" (paid by the activating player), "damage" (lose LP) or "gain".',
    input: z.object({ player: seat, amount: z.number().int(), kind: z.enum(['damage', 'cost', 'gain']) }),
  },
  modify_stats: {
    description:
      'Change a face-up monster\'s ATK/DEF and Level. atk and def are gains or losses (deltas, may be negative, 0 for none). atk_set and def_set make the stat "become" a value (null to leave it): the latest set wins, and gains and losses still apply on top. level_delta is added to the Level, or level_set makes it that Level (null to leave it). Lasts until `until`, and always ends when the monster leaves the field. "Until the End Phase" means end_of_turn.',
    input: z.object({
      card,
      atk: z.number().int(),
      def: z.number().int(),
      atk_set: z.number().int().nullable(),
      def_set: z.number().int().nullable(),
      level_delta: z.number().int(),
      level_set: z.number().int().nullable(),
      until: z.enum(UNTIL),
    }),
  },
  change_position: {
    description: 'Change a monster\'s battle position. A face-down monster becomes face-up.',
    input: z.object({ card, position }),
  },
  draw: {
    description: 'A player draws cards from the top of their Deck.',
    input: z.object({ player: seat, count: z.number().int() }),
  },
  extra_normal_summon: {
    description: 'Let a player conduct one more Normal Summon or Set this turn (Double Summon).',
    input: z.object({ player: seat }),
  },
  negate_attack: {
    description: 'Negate the attack being made ("negate the attack"): it ends with no damage.',
    input: z.object({}),
  },
  link: {
    description:
      'Equip the card being resolved (an Equip Spell) to a face-up monster, or tie a Continuous Trap to the monster it works on ("that monster cannot attack", Birthright\'s Special Summoned monster). Code then applies its continuous effect to that monster and destroys the card when the monster leaves the field. Only while resolving.',
    input: z.object({ card }),
  },
  negate_activation: {
    loose: true,
    description:
      'Negate the activation of a card or effect below this one on the chain ("negate the activation"): it resolves doing nothing. Name the card whose activation it is. "And if you do, destroy it" is a separate destroy call.',
    input: z.object({ card }),
  },
  negate_effects: {
    loose: true,
    description: 'A face-up monster has its effects negated while it stays face-up on the field ("but it has its effects negated"): its triggers, ignition and continuous effects stop.',
    input: z.object({ card }),
  },
  set_again: {
    loose: true,
    description: 'Set the card being resolved face-down again instead of sending it to the GY ("Set this card face-down instead of sending it to the GY"). Only while resolving.',
    input: z.object({}),
  },
  forbid: {
    loose: true,
    description:
      'For the rest of this turn, stop a player declaring attacks ("your opponent cannot declare an attack this turn"), conducting their Battle Phase ("you cannot conduct your Battle Phase this turn") or Special Summoning ("you cannot Special Summon monsters from your hand for the rest of this turn"). filter: for special_summon, the monsters it stops ("from your hand": place "hand"; "Level 5 or higher monsters": place "any", level min 5; null for any monster); null for the others. side "you" in it is that player. except: a monster the ban doesn\'t cover ("Other monsters cannot attack this turn": the card itself), else null.',
    input: z.object({ player: seat, what: z.enum(FORBIDDEN), filter: cardFilter.nullable(), except: card.nullable() }),
  },
  add_counters: {
    loose: true,
    description: 'Place counters on a face-up card ("place 1 Spell Counter on it"). max: the most it can hold ("max. 1"), or null.',
    input: z.object({ card, counter: z.enum(['spell']), count: z.number().int().min(1), max: z.number().int().min(1).nullable() }),
  },
  remove_counters: {
    loose: true,
    description: 'Remove counters from a card ("remove 1 Spell Counter from this card"), usually as a cost.',
    input: z.object({ card, counter: z.enum(['spell']), count: z.number().int().min(1) }),
  },
  detach: {
    loose: true,
    description: 'Detach an Xyz Material from the Xyz Monster it is attached to: it goes to its owner\'s GY. One call per material.',
    input: z.object({ card }),
  },
  declare_targets: {
    description: 'Record the targets of the effect being activated. Only while checking an activation, after the player chose them.',
    input: z.object({ cards: z.array(card) }),
  },
  choose_effect: {
    description: 'Record which effect the player chose, when the text offers several ("Activate 1 of these effects"). Only while checking an activation, after the player chose. Use the wording of the choice they picked.',
    input: z.object({ choice: z.string() }),
  },
} as const;

export const askPlayer = z.object({
  player: seat,
  prompt: z.string().describe('The question, e.g. "Choose 1 card to discard." Never name a card the player can\'t see.'),
  cards: z.array(card).describe('Cards to choose from. Empty if the choice is not of cards.'),
  choices: z.array(z.string()).describe('Non-card options, e.g. ["Gain 1200 LP", "Inflict 800 damage"]. Empty if choosing cards.'),
  min: z.number().int(),
  max: z.number().int(),
});

// The summary comes first, so the model has written its reasoning before it commits to the verdict.
export const finish = z.object({
  summary: z
    .string()
    .describe('One short sentence for both players\' logs: why an activation is illegal, or what the effect did. Never name a card a player can\'t see.'),
  legal: z.boolean().describe('Checking an activation: whether it is legal, as the summary concludes. Resolving: always true.'),
});

export const randomCards = z.object({ player: seat, count: z.number().int() });

export type AskPlayer = z.infer<typeof askPlayer>;
export type Finish = z.infer<typeof finish>;

/** Keeps only the JSON Schema keywords strict tool use and structured outputs accept. */
export function strictSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node)
        .filter(([k]) => !['$schema', 'minimum', 'maximum'].includes(k))
        .map(([k, v]) => [k, clean(v)]),
    );
  };
  return clean(json) as Anthropic.Tool.InputSchema;
}

const tool = (name: string, description: string, input: z.ZodType, strict = true): Anthropic.Tool => ({
  name,
  description,
  input_schema: strictSchema(input),
  strict,
});

/** Tool definitions in a fixed order, so the prompt cache holds. */
export const TOOLS: Anthropic.Tool[] = [
  ...Object.entries(opTools).map(([name, t]) => tool(name, t.description, t.input, !('loose' in t))),
  tool(
    'ask_player',
    'Ask a player to choose, and wait for the answer: costs such as "discard 1 card", targets, searches, or a choice between effects. The answer is the list of picked card IDs or choices.',
    askPlayer,
  ),
  tool(
    'random_cards',
    'Pick cards from a player\'s hand at random, for "random" in the text ("discard 2 random cards from your opponent\'s hand"). The answer is the picked card IDs (all of the hand if it holds fewer); then apply the effect to them with ops.',
    randomCards,
  ),
  tool('finish', 'End this judge call. Nothing you did takes effect until you call it; call it last, alone or after the turn\'s other calls succeed.', finish),
];

/** Parses one tool call as an op, or explains what was wrong. */
export function parseOp(name: string, input: unknown): { ok: true; op: Op } | { ok: false; error: string } {
  const spec = opTools[name as keyof typeof opTools];
  if (!spec) return { ok: false, error: `Unknown tool ${name}.` };
  const parsed = spec.input.safeParse(input);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, op: { op: name, ...parsed.data } as Op };
}
