// The card filter (see CardFilter in the engine's types.ts) as a Zod schema, shared by effect sheets and the judge's ops.

import { z } from 'zod';
import type { CardFilter } from '@yugioh/engine';

const range = z.object({ min: z.number().int().nullable(), max: z.number().int().nullable() }).nullable();

export const cardFilter = z.object({
  side: z.enum(['you', 'opponent', 'either']),
  place: z.enum(['field', 'monsters', 'spellTraps', 'hand', 'deck', 'graveyard', 'banished', 'any']),
  kinds: z.array(z.enum(['monster', 'spell', 'trap'])),
  types: z.array(z.string()),
  races: z.array(z.string()),
  attributes: z.array(z.string()),
  named: z.string().nullable(),
  faceUp: z.boolean().nullable(),
  position: z.enum(['attack', 'defense']).nullable(),
  level: range,
  atk: range,
  def: range,
}) satisfies z.ZodType<CardFilter>;
