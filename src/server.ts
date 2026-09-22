/**
 * The server shared by both preview and PDF export
 *
 * Why a server is still opened during PDF export: so Chromium loads files
 * (fonts / images / CSS / KaTeX) through the exact same URLs seen on the preview
 * page. The result is a true "what you see is what you get".
 */
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { ROOT, renderErrorPage, renderProblem } from './render.js';
import { ensureAllAssetsLocal, ensureAssetLocal } from './storage-db.js';

const KATEX_DIST = path.join(ROOT, 'node_modules', 'katex', 'dist');
const HLJS_STYLES = path.join(ROOT, 'node_modules', 'highlight.js', 'styles');

export const LIVE_RELOAD_CLIENT = `(() => {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let retry = 0;
  const connect = () => {
    const ws = new WebSocket(proto + '://' + location.host + '/__live');
    ws.addEventListener('open', () => { retry = 0; });
    ws.addEventListener('message', (event) => {
      if (event.data === 'reload') location.reload();
    });
    ws.addEventListener('close', () => {
      retry += 1;
      setTimeout(connect, Math.min(2000, 200 * retry));
    });
  };
  connect();
})();`;

export interface ServerHandle {
  url: string;
  port: number;
  /** Tells every open tab to reload */
  reload: () => void;
  close: () => Promise<void>;
}

export interface ServerOptions {
  /** 0 = let the system pick a free port */
  port?: number;
  /** Whether to enable websocket auto-reload */
  live?: boolean;
  /** Whether to show the warnings box on the page */
  showWarnings?: boolean;
}

export async function startServer(problemDir: string, options: ServerOptions = {}): Promise<ServerHandle> {
  const { port = 0, live = false, showWarnings = live } = options;
  const app = express();

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.get('/', async (_req, res) => {
    try {
      // renderProblem() resolves image paths against local disk (see render.ts's toAssetUrl), which
      // is this instance's scratch space. Pull every image for this problem down first so a cold
      // instance does not render the page — or, via Chromium, the exported PDF — as if the images
      // were missing. No-ops when no database is configured.
      await ensureAllAssetsLocal(path.basename(problemDir));
      const { html } = renderProblem(problemDir, { live, showWarnings });
      res.type('html').send(html);
    } catch (err) {
      res.status(200).type('html').send(renderErrorPage(err, live));
    }
  });

  if (live) {
    app.get('/__live-reload.js', (_req, res) => {
      res.type('js').send(LIVE_RELOAD_CLIENT);
    });
  }

  app.use('/assets', express.static(path.join(ROOT, 'assets'), { fallthrough: true }));
  // Chromium loads every problem image through this route during PDF and booklet export.
  // express.static on its own reads only this instance's working copy, so on a cold instance (an
  // evicted /tmp, or an image another instance uploaded) an export silently produced a PDF with
  // the images missing and no error anywhere. Hydrating from the database here — the same gate
  // Studio's own /problem-assets route uses — makes the database the authority for these bytes on
  // every read path, not just the pre-render pass above.
  const problemAssetsDir = path.join(problemDir, 'assets');
  app.use(
    '/problem-assets',
    async (req, _res, next) => {
      try {
        const parts = decodeURIComponent(req.path)
          .split('/')
          .filter((part) => part && part !== '.');
        const target = path.normalize(path.join(problemAssetsDir, ...parts));
        // Path traversal guard: only hydrate a path that stays inside assets/
        if (parts.length > 0 && target.startsWith(`${path.normalize(problemAssetsDir)}${path.sep}`)) {
          await ensureAssetLocal(path.basename(problemDir), ['assets', ...parts].join('/'));
        }
      } catch {
        // Hydration is best effort: the static handler below still answers, with a 404 if the
        // image genuinely does not exist. Never fail the whole request over a fetch attempt.
      }
      next();
    },
    express.static(problemAssetsDir, { fallthrough: true }),
  );
  app.use('/vendor/katex', express.static(KATEX_DIST));
  app.use('/vendor/hljs', express.static(HLJS_STYLES));

  const server = http.createServer(app);
  const sockets = new Set<WebSocket>();
  let wss: WebSocketServer | undefined;

  if (live) {
    wss = new WebSocketServer({ server, path: '/__live' });
    wss.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    // ws re-emits the underlying server's errors (e.g. EADDRINUSE) on the WebSocketServer itself.
    // Without a listener here, that unhandled 'error' event crashes the whole process — even though
    // server.once('error', reject) below already handles it correctly for the port-retry logic.
    wss.on('error', () => undefined);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://127.0.0.1:${actualPort}`,
    port: actualPort,
    reload: () => {
      for (const socket of sockets) {
        if (socket.readyState === socket.OPEN) socket.send('reload');
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        sockets.clear();
        wss?.close();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
