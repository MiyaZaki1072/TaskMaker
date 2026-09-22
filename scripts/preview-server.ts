/**
 * npm run preview problems/<problem name>
 *
 * Starts a local server, shows the rendered problem, and reloads automatically every time the file is saved.
 */
import path from 'node:path';
import chokidar from 'chokidar';
import { Command } from 'commander';
import open from 'open';
import { ProblemError, reportAndExit } from '../src/errors.js';
import { listProblemDirs, resolveProblemDir, ROOT } from '../src/render.js';
import { startServer, type ServerHandle } from '../src/server.js';

const DEFAULT_PORT = 4321;
const MAX_PORT_TRIES = 20;

/** If the port is busy, automatically try the next one so the user doesn't have to fix it themselves */
async function startOnFreePort(problemDir: string, wanted: number): Promise<ServerHandle> {
  for (let port = wanted; port < wanted + MAX_PORT_TRIES; port += 1) {
    try {
      return await startServer(problemDir, { port, live: true, showWarnings: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw err;
    }
  }
  throw new ProblemError(
    `Could not start the server — ports ${wanted}-${wanted + MAX_PORT_TRIES - 1} are all in use`,
    {
      hint:
        'Close any old preview window that is still running, then try again — ' +
        'or specify a different port, e.g.  npm run preview problems/problem name -- --port 5000',
    },
  );
}

function pickProblem(input: string | undefined): string {
  if (input) return resolveProblemDir(input);

  const dirs = listProblemDirs();
  if (dirs.length === 1) return dirs[0]!;
  if (dirs.length === 0) {
    throw new ProblemError('There are no problems to preview yet', {
      hint: 'Create your first problem with  npm run new "problem name"',
    });
  }
  throw new ProblemError('No problem was specified to preview', {
    details: dirs.map((dir) => `npm run preview problems/${path.basename(dir)}`),
    hint: 'Copy and run one of the commands above',
  });
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('npm run preview')
    .argument('[problem]', 'the problem folder, e.g. problems/Example_Task')
    .option('--port <number>', 'the port to use', String(DEFAULT_PORT))
    .option('--no-open', 'do not open the browser automatically')
    .parse(process.argv);

  const options = program.opts<{ port: string; open: boolean }>();
  const problemDir = pickProblem(program.args[0]);
  const wantedPort = Number.parseInt(options.port, 10) || DEFAULT_PORT;

  const server = await startOnFreePort(problemDir, wantedPort);
  const relative = path.relative(ROOT, problemDir).replace(/\\/g, '/');

  console.log('');
  console.log(`  Previewing: ${relative}`);
  console.log(`  Open this page in your browser: ${server.url}`);
  console.log('  Edit problem.yaml and save — the page will update automatically');
  console.log('  Press Ctrl + C to stop');
  console.log('');

  // Watch both the problem's own files and the shared template/CSS (in case someone tweaks the template/CSS)
  const watcher = chokidar.watch(
    [
      path.join(problemDir, 'problem.yaml'),
      path.join(problemDir, 'assets'),
      path.join(ROOT, 'templates'),
      path.join(ROOT, 'assets', 'style.css'),
    ],
    { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 } },
  );

  let timer: NodeJS.Timeout | undefined;
  const scheduleReload = (file: string) => {
    // Coalesce multiple simultaneous events into a single reload
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const shown = path.relative(ROOT, file).replace(/\\/g, '/') || file;
      console.log(`  Updated: ${shown}`);
      server.reload();
    }, 60);
  };

  watcher.on('all', (_event, file) => scheduleReload(file));

  if (options.open) {
    await open(server.url).catch(() => {
      console.log('  (Could not open the browser automatically — copy the URL above and open it yourself)');
    });
  }

  const shutdown = async () => {
    await watcher.close();
    await server.close();
    console.log('\n  Server stopped\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(reportAndExit);
