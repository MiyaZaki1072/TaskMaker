/**
 * npm run db:init
 * Verifies DATABASE_URL is set and reachable, and creates the `problems`/`problem_assets`
 * tables if they don't exist yet. Safe to run any number of times (CREATE TABLE IF NOT EXISTS).
 * Studio also does this automatically on cold start, so this is mainly for checking your setup
 * before deploying, or for preparing a fresh database by hand.
 */
import { isDbConfigured, initSchema } from '../src/storage-db.js';

async function main(): Promise<void> {
  if (!isDbConfigured()) {
    console.error('DATABASE_URL is not set.');
    console.error('Start the stack with docker compose up -d, which sets it for you, or point');
    console.error('set DATABASE_URL locally (e.g. in your shell, or a .env file you load yourself)');
    console.error('to the connection string it gives you, and run this again.');
    process.exitCode = 1;
    return;
  }

  console.log('Connecting and ensuring the schema exists...');
  await initSchema();
  console.log('Done — the `problems` and `problem_assets` tables are ready.');
}

main().catch((err) => {
  console.error('Could not set up the database:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
