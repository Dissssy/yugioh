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
createApp(config, db).listen(config.PORT, () => {
  console.log(`Server listening on http://localhost:${config.PORT} (public URL ${config.BASE_URL})`);
});
