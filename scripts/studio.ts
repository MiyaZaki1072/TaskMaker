/**
 * npm run studio
 * Opens the web dashboard that controls every command (new problem / edit + preview / manage images / export PDF / validate)
 */
import { Command } from 'commander';
import open from 'open';
import { ProblemError, reportAndExit } from '../src/errors.js';
import { startStudio, type StudioHandle } from '../src/studio-server.js';

const DEFAULT_PORT = 4322;
const MAX_PORT_TRIES = 20;

async function startOnFreePort(wanted: number): Promise<StudioHandle> {
  for (let port = wanted; port < wanted + MAX_PORT_TRIES; port += 1) {
    try {
      return await startStudio(port);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
    }
  }
  throw new ProblemError(
    `Could not start the server — ports ${wanted}-${wanted + MAX_PORT_TRIES - 1} are all in use`,
    { hint: 'Close any old Studio window that is still running, then try again' },
  );
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('npm run studio')
    .option('--port <number>', 'the port to use', String(DEFAULT_PORT))
    .option('--no-open', 'do not open the browser automatically')
    .parse(process.argv);

  const options = program.opts<{ port: string; open: boolean }>();
  const wantedPort = Number.parseInt(options.port, 10) || DEFAULT_PORT;

  const studio = await startOnFreePort(wantedPort);

  console.log('');
  console.log('  Studio dashboard is open at:', studio.url);
  console.log('  This page replaces new / preview / pdf / pdf:all / pdf:booklet / validate');
  console.log('  Press Ctrl + C to stop');
  console.log('');

  if (options.open) {
    await open(studio.url).catch(() => {
      console.log('  (Could not open the browser automatically — copy the URL above and open it yourself)');
    });
  }

  const shutdown = async () => {
    await studio.close();
    console.log('\n  Studio stopped\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(reportAndExit);
