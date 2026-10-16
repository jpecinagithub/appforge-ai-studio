import { loadConfig } from './config.js';
import { migrationsDir, openDatabase, runMigrations } from './db/index.js';

/**
 * Standalone migration runner: `npm run migrate`.
 * Used by the Studio's run_migrations operation (ephemeral container).
 */
function main() {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  try {
    const results = runMigrations(db, migrationsDir(), (m) =>
      console.log(m),
    );
    for (const r of results) {
      console.log(
        `${r.applied ? 'applied' : 'already applied'}: ${r.name}`,
      );
    }
    const fresh = results.filter((r) => r.applied).length;
    console.log(`done: ${fresh} new migration(s)`);
  } finally {
    db.close();
  }
}

main();
