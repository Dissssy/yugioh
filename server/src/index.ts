import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { connect } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';

const config = loadConfig();
const db = connect(config.DATABASE_URL);
await runMigrations(db);
createApp(config, db).listen(config.PORT, () => {
  console.log(`Server listening on http://localhost:${config.PORT} (public URL ${config.BASE_URL})`);
});
