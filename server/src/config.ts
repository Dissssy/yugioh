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
  /** Questions to the judge per player per duel (docs/ask-the-judge.md). */
  QUESTIONS_PER_DUEL: z.coerce.number().int().nonnegative().default(20),
  /** The model the AI opponent plays with (docs/ai-opponent.md). It must have a price in judge/pricing.ts. */
  AI_OPPONENT_MODEL: z.string().min(1).default('claude-haiku-5-5'),
  /** Model calls the AI opponent may make per duel; at the limit it surrenders. */
  AI_CALLS_PER_DUEL: z.coerce.number().int().positive().default(400),
  /**
   * How long a response window stays open, at least, before the server passes for a player who has nothing to
   * activate, so the speed of a pass reveals nothing. A random extra of up to half as long is added.
   */
  RESPONSE_FLOOR_MS: z.coerce.number().int().nonnegative().default(2000),
  /**
   * Development only: at start, throw away every stored effect sheet, revision and report and load the sheets from
   * server/effect-sheets/ again, so a deploy plays the repository's sheets and nothing players flagged.
   */
  RESET_SHEETS: z.stringbool().default(false),
  /** The Discord app behind the Activity (docs/discord.md). Without all three, the Activity can't sign anyone in. */
  DISCORD_CLIENT_ID: z.string().min(1).optional(),
  DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
  DISCORD_BOT_TOKEN: z.string().min(1).optional(),
});

export const cardImageDir = (source: NodeJS.ProcessEnv = process.env) => env.shape.CARD_IMAGE_DIR.parse(source.CARD_IMAGE_DIR);

export type Config = z.infer<typeof env>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const config = env.parse(source);
  const discord = [config.DISCORD_CLIENT_ID, config.DISCORD_CLIENT_SECRET, config.DISCORD_BOT_TOKEN];
  if (discord.some(Boolean) && !discord.every(Boolean)) throw new Error('Set all of DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET and DISCORD_BOT_TOKEN, or none.');
  return config;
}
