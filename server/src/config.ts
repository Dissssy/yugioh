import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const env = z.object({
  BASE_URL: z.url(),
  PORT: z.coerce.number().int().default(3000),
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  AUTH0_ISSUER_BASE_URL: z.url(),
  AUTH0_CLIENT_ID: z.string().min(1),
  AUTH0_CLIENT_SECRET: z.string().min(1),
  ADMIN_EMAIL: z.email().transform((s) => s.toLowerCase()),
  /** Downloaded card images. Must survive redeploys in production. */
  CARD_IMAGE_DIR: z.string().default(fileURLToPath(new URL('../../data/card-images', import.meta.url))),
  /** Pays for the judge and appeals. Without it, duels still run but card effects can't be activated. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Judge calls per duel; an activation and its resolution are two. */
  JUDGE_CALLS_PER_DUEL: z.coerce.number().int().positive().default(300),
  /** Contests per duel, both players together. */
  APPEALS_PER_DUEL: z.coerce.number().int().nonnegative().default(10),
});

export const cardImageDir = (source: NodeJS.ProcessEnv = process.env) => env.shape.CARD_IMAGE_DIR.parse(source.CARD_IMAGE_DIR);

export type Config = z.infer<typeof env>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  return env.parse(source);
}
