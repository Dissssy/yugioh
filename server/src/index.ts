import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './app.ts';
import { scheduleCardSync } from './cards.ts';
import { loadConfig } from './config.ts';
import { connect } from './db/client.ts';
import { scheduleGuestCleanup } from './guests.ts';
import { runMigrations } from './db/migrate.ts';

const config = loadConfig();
const db = connect(config.DATABASE_URL);
await runMigrations(db);
scheduleCardSync(db, { imageDir: config.CARD_IMAGE_DIR, log: console.log });
scheduleGuestCleanup(db);
const client = config.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }) : null;
if (!client) console.warn('No ANTHROPIC_API_KEY: card effects and appeals are off.');
const model = client && ((params: Anthropic.MessageCreateParamsNonStreaming) => client.messages.create(params));
const ai = { judge: model, appeal: model, judgeCalls: config.JUDGE_CALLS_PER_DUEL, appeals: config.APPEALS_PER_DUEL };
createApp(config, db, ai).listen(config.PORT, () => {
  console.log(`Server listening on http://localhost:${config.PORT} (public URL ${config.BASE_URL})`);
});
