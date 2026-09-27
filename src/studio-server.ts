/**
 * "Studio" — a single web app that wraps every CLI command into one dashboard:
 * create a new problem / edit files + live preview / manage images / export PDF one-by-one, all, or as a booklet / validate
 *
 * Unlike src/server.ts (a server for a single problem, used for CLI preview/pdf), Studio is
 * one Express app that manages "many" problems at once, so it needs a :folder route and
 * separates image URLs via assetsBasePath so problems don't collide with each other.
 *
 * This file only wires the app together — the order of the middleware matters, so it is all
 * here in one place. The routes themselves live in src/routes/, one file per feature:
 *
 *   routes/auth.ts        sign-in, sessions, the cross-site request block
 *   routes/pages.ts       dashboard, editor, preview, scoreboard and library pages
 *   routes/assets.ts      CSS, fonts, browser scripts, problem and library images
 *   routes/problems.ts    /api/problems — list, create, delete, YAML, images
 *   routes/pdf.ts         /api — PDF export and booklets
 *   routes/scoreboard.ts  /api/scoreboard
 *   routes/library.ts     /api/library — shared images and snippets
 *   routes/zip.ts         /api — ZIP export and import
 */
import http from 'node:http';
import path from 'node:path';
import chokidar from 'chokidar';
import express, { type NextFunction, type Request, type Response } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
// Named import (not default): some 8.x builds drop the `rateLimit as default` alias,
// which breaks the build with "no call signatures". The named export is stable across versions.
import { rateLimit } from 'express-rate-limit';
import { PROBLEMS_DIR, ROOT } from './render.js';
import { backgroundSync, initStorage, isDbConfigured, storageHealth } from './storage-db.js';
import { assetRoutes } from './routes/assets.js';
import { authRoutes } from './routes/auth.js';
import { libraryRoutes } from './routes/library.js';
import { pageRoutes } from './routes/pages.js';
import { pdfRoutes } from './routes/pdf.js';
import { problemRoutes } from './routes/problems.js';
import { scoreboardRoutes } from './routes/scoreboard.js';
import { closeBrowser, sendError } from './routes/shared.js';
import { zipRoutes } from './routes/zip.js';

export interface StudioHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export interface StudioAppOptions {
  /**
   * The address the server is actually bound to, when the caller knows it.
   *
   * This exists because the alternative — reading process.env.HOST — is wrong in the one case
   * that matters. scripts/serve.ts defaults to binding 0.0.0.0 when HOST is unset, so the app
   * would read an empty HOST, conclude "nobody else can reach this, no password needed", and
   * then serve an unauthenticated studio on every network interface. Passing the real bound
   * address makes the decision follow ground truth instead of a variable that may not exist.
   */
  boundHost?: string;
}

export function createStudioApp(options: StudioAppOptions = {}): express.Express {
  const app = express();

  // Trust exactly one proxy hop. Required so express-rate-limit (and the login throttle) read the
  // real client IP from X-Forwarded-For instead of the proxy's — without it, rate limiting behind
  // a proxy either throws or counts every visitor as the same client.
  //
  // One hop is right for the usual setup: a cloudflared tunnel in front of the container.
  // TRUST_PROXY overrides it for a different chain (say cloudflared -> nginx -> app, which is
  // two). Off by default, because blindly trusting X-Forwarded-For lets a client spoof its own
  // IP past the rate limiter.
  const trustProxy = process.env.TRUST_PROXY ?? '';
  if (trustProxy) {
    const hops = Number(trustProxy);
    app.set('trust proxy', Number.isFinite(hops) && String(hops) === trustProxy ? hops : trustProxy);
  }

  // Hydrate the working copy from the database if one is configured. We must wait for this to
  // finish before handling any request, otherwise a request right after boot hits an empty
  // working copy and fails with "problem not found".
  const storageReady: Promise<void> = initStorage().catch((err) => console.error('[Storage Init Error]', err));

  // Hold the first requests until that finishes: the container's working copy starts empty on
  // every restart, so a request
  // that arrives during boot would otherwise 404 a problem that exists perfectly well in Postgres.
  // Without a database there is nothing to wait for: local disk is already the whole truth.
  if (isDbConfigured()) {
    app.use((_req, _res, next) => {
      storageReady.then(() => next(), () => next());
    });
  }

  // Security headers: protect against clickjacking and MIME sniffing
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Liveness probe. Deliberately before the auth gate and deliberately dull: Docker's HEALTHCHECK
  // and server dashboards need to reach it without credentials, so it reports whether the
  // process is up and whether the database is answering — never anything about the content.
  app.get('/healthz', (_req, res) => {
    const health = storageHealth();
    res.status(health.ok ? 200 : 503).json({ ok: health.ok, database: health.ok ? 'ok' : 'unreachable' });
  });

  // Sign-in gate. Everything registered after this line requires a signed-in session (or the
  // password header), and state-changing requests must come from the studio itself.
  app.use(authRoutes(options.boundHost));

  // General rate limiting: max 150 requests per minute per IP
  const generalLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 150,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { message: 'Too many requests, please wait a minute' } },
  });
  app.use(generalLimiter);

  // Nudge the working copy towards the database, but never make the response wait for it. The
  // routes that actually need freshness ask for exactly what they need instead: the dashboard
  // does one query, opening or saving a problem does one query on that problem alone.
  const STATIC_PREFIXES = ['/assets/', '/studio-assets/', '/vendor/', '/favicon', '/__live'];
  app.use((req, _res, next) => {
    if (!STATIC_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      backgroundSync();
    }
    next();
  });

  // Rate limiting for heavy operations (PDF / Booklet / ZIP import): max 10 per minute per IP.
  // One instance shared by every route that uses it, so they all count against the same budget.
  const heavyLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { message: 'Too many heavy requests, please wait a minute and try again' } },
  });

  app.use(pageRoutes());
  app.use(assetRoutes());

  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));
  api.use(problemRoutes());
  api.use(pdfRoutes(heavyLimiter));
  api.use(scoreboardRoutes(heavyLimiter));
  api.use(libraryRoutes());
  api.use(zipRoutes(heavyLimiter));

  // Catch errors that slip out of other middleware (e.g. express.json() hitting malformed JSON)
  api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    sendError(res, err);
  });

  app.use('/api', api);

  return app;
}

export async function startStudio(port = 0, host = process.env.HOST || '127.0.0.1'): Promise<StudioHandle> {
  // Tell the app where it is actually listening, so its "does this need a password?" decision is
  // based on the real bind address rather than on whether an env var happens to be set.
  const app = createStudioApp({ boundHost: host });

  // ---------- Server + live reload ----------
  const server = http.createServer(app);
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ server, path: '/__live' });
  wss.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // ws re-emits the underlying server's errors (e.g. EADDRINUSE) on the WebSocketServer itself.
  // Without a listener here, that unhandled 'error' event crashes the whole process — even though
  // server.once('error', reject) below already handles it correctly for the port-retry logic.
  wss.on('error', () => undefined);

  function broadcastReload(): void {
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send('reload');
    }
  }

  // Watch every problem at once (not just the one currently open) in case someone edits a file directly in a text editor
  const watcher = chokidar.watch(
    [PROBLEMS_DIR, path.join(ROOT, 'templates'), path.join(ROOT, 'assets', 'style.css')],
    { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 } },
  );
  let debounceTimer: NodeJS.Timeout | undefined;
  watcher.on('all', () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(broadcastReload, 60);
  });

  // 127.0.0.1 by default: `npm run studio` is a single-user tool and should not be reachable from
  // the rest of the network just because someone ran it on a laptop in a cafe. The container sets
  // HOST=0.0.0.0, because there the only thing that can reach the port is what Docker publishes
  // to it — see docker-compose.yml, which binds it to the host loopback for cloudflared.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  // 0.0.0.0 is not a dialable address — print something a browser can actually open.
  const displayHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;

  return {
    url: `http://${displayHost}:${actualPort}`,
    port: actualPort,
    close: async () => {
      await watcher.close();
      for (const socket of sockets) socket.terminate();
      sockets.clear();
      wss.close();
      await closeBrowser();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
