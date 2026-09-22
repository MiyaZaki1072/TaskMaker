/**
 * Long-running server entrypoint for the self-hosted (ZimaOS / Docker) deployment.
 *
 * How this differs from `npm run studio` (scripts/studio.ts), which is the same app:
 *   - binds 0.0.0.0 by default, because nothing outside the container could reach it otherwise
 *   - never tries to open a browser — there is no desktop here
 *   - shuts down on SIGTERM, which is the signal Docker actually sends on `docker stop`, so
 *     in-flight PDF exports finish and the Postgres pool closes instead of the container being
 *     killed ten seconds later by the timeout
 *   - refuses to start without a database, rather than silently serving a working copy that
 *     disappears on the next restart
 */
import { studioPassword } from '../src/auth.js';
import { closePool, isDbConfigured } from '../src/db.js';
import { reportAndExit } from '../src/errors.js';
import { PROBLEMS_DIR, PROBLEMS_DIR_DISPOSABLE } from '../src/render.js';
import { startStudio } from '../src/studio-server.js';

const DEFAULT_PORT = 4322;

async function main(): Promise<void> {
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;
  const host = process.env.HOST || '0.0.0.0';

  if (!isDbConfigured()) {
    console.error('');
    console.error('  DATABASE_URL is not set.');
    console.error('');
    console.error('  This server keeps problems in Postgres; the copy on its own filesystem is a');
    console.error('  scratch copy that is thrown away when the container restarts. Starting without');
    console.error('  a database would mean every problem written is lost on the next restart, so it');
    console.error('  stops here instead.');
    console.error('');
    console.error('  In the ZimaOS stack this is set for you by docker-compose.yml.');
    console.error('');
    process.exit(1);
  }

  // Refuse to start without a password, the same way we refuse without a database.
  //
  // The app itself also blocks unauthenticated access whenever it is reachable from off-box, but
  // that check is a last line of defence. This one is unconditional: a server whose whole job is
  // to be reached over a network has no business running open, and failing loudly at startup is
  // far better than discovering it by finding a stranger's problems in the database.
  if (!studioPassword()) {
    console.error('');
    console.error('  STUDIO_PASSWORD is not set.');
    console.error('');
    console.error('  This server listens on a network interface, so starting without a password');
    console.error('  would let anyone who can reach the port read, rewrite and delete every');
    console.error('  problem. It stops here instead.');
    console.error('');
    console.error('  In the ZimaOS stack this comes from the .env file next to docker-compose.yml.');
    console.error('  For a quick local run:  STUDIO_PASSWORD=something npm run serve');
    console.error('');
    process.exit(1);
  }

  const studio = await startStudio(port, host);

  console.log('');
  console.log(`  Problem Studio is listening on ${host}:${studio.port}`);
  console.log(`  Working copy: ${PROBLEMS_DIR}${PROBLEMS_DIR_DISPOSABLE ? ' (disposable — Postgres is the durable copy)' : ''}`);
  console.log('');

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    // Docker sends SIGTERM, waits, then SIGKILLs. A second signal during a slow shutdown is a
    // human getting impatient — let the first one finish rather than tearing down twice.
    if (closing) return;
    closing = true;
    console.log(`\n  ${signal} received — shutting down`);
    await studio.close().catch((err) => console.error('  Error while stopping the server:', err));
    await closePool();
    console.log('  Stopped\n');
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(reportAndExit);
