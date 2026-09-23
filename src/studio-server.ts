/**
 * "Studio" — a single web app that wraps every CLI command into one dashboard:
 * create a new problem / edit files + live preview / manage images / export PDF one-by-one, all, or as a booklet / validate
 *
 * Unlike src/server.ts (a server for a single problem, used for CLI preview/pdf), Studio is
 * one Express app that manages "many" problems at once, so it needs a :folder route and
 * separates image URLs via assetsBasePath so problems don't collide with each other.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import chokidar from 'chokidar';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { type Browser } from 'puppeteer';
import { WebSocketServer, type WebSocket } from 'ws';
// Named import (not default): some 8.x builds drop the `rateLimit as default` alias,
// which breaks the build with "no call signatures". The named export is stable across versions.
import { rateLimit } from 'express-rate-limit';
import { buildBooklet } from './booklet.js';
import { ProblemError } from './errors.js';
import { exportProblemPdf, launchBrowser } from './pdf-export.js';
import {
  assetInfo,
  checkProblem,
  deleteProblemAsset,
  listProblemAssets,
  MAX_PROBLEMS,
  sanitizeAssetName,
  saveProblemAsset,
  type ProblemCheck,
} from './problem-ops.js';
import AdmZip from 'adm-zip';
import {
  DIST_DIR,
  IMMUTABLE_ASSET,
  listProblemDirs,
  loadProblem,
  PROBLEMS_DIR,
  renderErrorPage,
  renderProblem,
  ROOT,
} from './render.js';
import { LIVE_RELOAD_CLIENT } from './server.js';
import {
  backgroundSync,
  createProblemInStorage,
  currentVersion,
  deleteAssetInStorage,
  deleteProblemInStorage,
  ensureAllAssetsLocal,
  ensureAssetLocal,
  ensureProblemCurrent,
  ensureProblemPresent,
  importParsedProblems,
  initStorage,
  isDbConfigured,
  listAssetsInStorage,
  listKnownFolders,
  saveAssetInStorage,
  saveProblemYamlInStorage,
  StorageConflictError,
  storageHealth,
  syncFromStorage,
} from './storage-db.js';
import { dashboardPage, editorPage, loginPage } from './studio-pages.js';
import {
  clearSession,
  hasValidSession,
  issueSession,
  originAllowed,
  secretsMatch,
  studioPassword,
} from './auth.js';

const KATEX_DIST = path.join(ROOT, 'node_modules', 'katex', 'dist');
const HLJS_STYLES = path.join(ROOT, 'node_modules', 'highlight.js', 'styles');
const STUDIO_PUBLIC = path.join(ROOT, 'src', 'studio-public');

interface ParsedZipProblem {
  folder: string;
  yaml: string;
  assets: Array<{ filename: string; data: Buffer }>;
}

/**
 * Parses a ZIP into problem records in memory — no filesystem writes here. This lets the
 * database (when configured) decide what actually gets kept — the MAX_PROBLEMS cap and the
 * atomic multi-row write — before anything touches local disk; importParsedProblems in
 * storage-db.ts does that decision and the eventual materialization.
 */
function parseProblemsZip(buffer: Buffer, mode: 'add' | 'overwrite', existingFolders: Set<string>): ParsedZipProblem[] {
  const zip = new AdmZip(buffer);
  const entries = zip.getEntries();

  const yamlEntries = entries.filter((e) => !e.isDirectory && /(?:^|[\\/])problem\.yaml$/i.test(e.entryName));
  if (yamlEntries.length === 0) {
    throw new ProblemError('No problem.yaml file found in the uploaded ZIP', {
      hint: 'Please check that the selected ZIP is a valid problem package',
    });
  }

  // Zip bomb protection: reject if the total decompressed size exceeds 100MB
  let totalDecompressedSize = 0;
  const MAX_ZIP_DECOMPRESSED = 100 * 1024 * 1024; // 100MB
  for (const entry of entries) {
    totalDecompressedSize += entry.header.size;
    if (totalDecompressedSize > MAX_ZIP_DECOMPRESSED) {
      throw new ProblemError('The ZIP file exceeds the safety limit for decompressed size (100MB)');
    }
  }

  // In 'add' mode, a folder name already taken (on disk, in the database, or by an earlier entry
  // in this same ZIP) gets a numeric suffix so it is imported as a new problem instead of
  // colliding with an existing one.
  const taken = new Set(existingFolders);
  const problemBases: { basePrefix: string; targetFolder: string }[] = [];

  for (const ye of yamlEntries) {
    const norm = ye.entryName.replace(/\\/g, '/');
    const idx = norm.lastIndexOf('/problem.yaml');
    let folderName = '';
    let basePrefix = '';
    if (idx === -1) {
      folderName = 'imported_problem';
      basePrefix = '';
    } else {
      const fullDir = norm.slice(0, idx);
      folderName = fullDir.split('/').filter(Boolean).at(-1) || 'imported_problem';
      basePrefix = fullDir + '/';
    }

    let targetFolder = folderName;
    if (mode === 'add') {
      if (taken.has(targetFolder)) {
        let suffix = 1;
        while (taken.has(`${targetFolder}_${suffix}`)) suffix += 1;
        targetFolder = `${targetFolder}_${suffix}`;
      }
      taken.add(targetFolder);
    }

    problemBases.push({ basePrefix, targetFolder });
  }

  const results: ParsedZipProblem[] = [];
  for (const pb of problemBases) {
    let yaml: string | undefined;
    const assets: Array<{ filename: string; data: Buffer }> = [];

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const norm = entry.entryName.replace(/\\/g, '/');
      let relativePath = '';
      if (pb.basePrefix === '') {
        relativePath = norm;
      } else if (norm.startsWith(pb.basePrefix)) {
        relativePath = norm.slice(pb.basePrefix.length);
      } else {
        continue;
      }
      if (!relativePath) continue;

      // Zip Slip protection: reject any entry whose relative path would escape the problem folder
      const normalizedRel = path.posix.normalize(relativePath);
      if (normalizedRel.startsWith('..') || path.posix.isAbsolute(normalizedRel)) continue;

      if (normalizedRel === 'problem.yaml') {
        yaml = entry.getData().toString('utf8');
      } else if (normalizedRel.startsWith('assets/') && normalizedRel !== 'assets/.gitkeep') {
        assets.push({ filename: normalizedRel.slice('assets/'.length), data: entry.getData() });
      }
    }

    if (yaml !== undefined) {
      results.push({ folder: pb.targetFolder, yaml, assets });
    }
  }

  return results;
}

// ---------- General helpers ----------

const FOLDER_RE = /^[^\\/]+$/;

/** Express 5 (path-to-regexp v8) always types req.params as string | string[] | undefined */
function paramStr(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Resolves a problem folder from a URL parameter, guarding against names containing / or .. that would escape problems/ */
function resolveFolder(folderParam: string): string {
  if (!FOLDER_RE.test(folderParam)) {
    throw new ProblemError(`Invalid problem name "${folderParam}"`);
  }
  const dir = path.join(PROBLEMS_DIR, folderParam);
  const rel = path.relative(PROBLEMS_DIR, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(path.join(dir, 'problem.yaml'))) {
    throw new ProblemError(`Problem "${folderParam}" not found`, {
      hint: 'This problem may have been deleted or moved — go back to the main page and pick another one',
    });
  }
  return dir;
}

/**
 * Resolves a problem folder, pulling it into the working copy first if it is not there yet. A
 * problem that is in the database but not yet on local disk (the working copy is rebuilt from the
 * database, in the background) would otherwise be reported as "not found" by every route that
 * resolves a folder. Free when the problem is already present.
 */
async function resolveFolderPresent(folderParam: string): Promise<string> {
  await ensureProblemPresent(folderParam);
  return resolveFolder(folderParam);
}

function sendError(res: Response, err: unknown): void {
  if (err instanceof StorageConflictError) {
    res.status(409).json({
      error: {
        message: err.message,
        hint: 'Go back to the main page to see the current list, then pick a different name',
      },
    });
    return;
  }
  if (err instanceof ProblemError) {
    res.status(400).json({ error: { message: err.message, details: err.details, hint: err.hint, file: err.file } });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: { message } });
}

type Handler = (req: Request, res: Response) => Promise<void> | void;

/** Wraps every API handler in a single try/catch so errors never leak out as HTML/a stack trace */
function handle(fn: Handler) {
  return (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));
  };
}

function checkToListItem(check: ProblemCheck) {
  return {
    folder: check.folder,
    code: check.code ?? check.folder,
    name: check.name ?? check.folder,
    ok: check.ok,
    warningCount: check.warnings.length,
    errorMessage: check.error?.message,
  };
}

function pdfDownloadUrl(folder: string): string {
  return `/api/problems/${encodeURIComponent(folder)}/pdf/file`;
}

// ---------- Main app ----------

export interface StudioHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

// Launch Chromium lazily (on first export) and reuse the same instance afterwards
let browserPromise: Promise<Browser> | undefined;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err: unknown) => {
      browserPromise = undefined;
      throw err;
    });
  }
  return browserPromise;
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
  // and the ZimaOS dashboard need to reach it without credentials, so it reports whether the
  // process is up and whether the database is answering — never anything about the content.
  app.get('/healthz', (_req, res) => {
    const health = storageHealth();
    res.status(health.ok ? 200 : 503).json({ ok: health.ok, database: health.ok ? 'ok' : 'unreachable' });
  });

  // ---------- Authentication ----------

  // Whether an unauthenticated studio would be reachable by anyone but the person running it.
  // `npm run studio` on a laptop binds loopback and stays open, which is the single-user dev
  // convenience it has always been. Anything else — the container (NODE_ENV=production,
  // HOST=0.0.0.0), or a deliberate bind to a routable address — must have a password or refuse to
  // serve, because an open studio lets anyone who finds the URL read, rewrite and delete every
  // problem.
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
  // The bound address the caller told us about wins; process.env.HOST is only a fallback for
  // callers that create the app without listening themselves (the verification scripts).
  const boundHost = options.boundHost ?? process.env.HOST;
  const reachableFromElsewhere =
    process.env.NODE_ENV === 'production' ||
    Boolean(boundHost && !LOOPBACK.has(boundHost));

  /** Paths that must work before anyone is logged in */
  const PUBLIC_PATHS = new Set(['/favicon.ico', '/healthz', '/login']);

  /**
   * Machine clients (scripts, curl, a monitoring check) send the password in a header instead of
   * holding a session. Kept from the previous Basic-auth gate so nothing that automated against
   * this studio breaks — but now compared in constant time, which the old `===` was not.
   */
  function headerCredentialsMatch(req: Request, password: string): boolean {
    const header = req.headers['x-studio-password'];
    if (typeof header === 'string' && secretsMatch(header, password)) return true;

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Basic ')) {
      try {
        const creds = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const colonIdx = creds.indexOf(':');
        const pass = colonIdx !== -1 ? creds.slice(colonIdx + 1) : creds;
        return secretsMatch(pass, password);
      } catch {
        /* malformed header — treat as no credentials */
      }
    }
    return false;
  }

  /** Whether this request wants JSON back (the page's fetch() calls) rather than an HTML page */
  function expectsJson(req: Request): boolean {
    return req.path.startsWith('/api/') || req.get('accept')?.includes('application/json') === true;
  }

  /**
   * Where to send someone after logging in. Only ever a path on this site: anyone who can choose
   * the destination of a post-login redirect can use the studio's own domain to launder a link to
   * theirs, so anything that is not a plain single-slash-prefixed path becomes "/".
   */
  function safeNext(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
    return raw;
  }

  // Login attempts are throttled separately from, and far harder than, ordinary traffic: this is
  // the one endpoint where guessing is the attack. Successful logins are not counted, so someone
  // who mistypes twice and then gets it right is not locked out by their own success.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many sign-in attempts. Please wait 15 minutes and try again.',
  });

  app.get('/login', async (req, res) => {
    const password = studioPassword();
    if (!password) {
      res.redirect(303, '/');
      return;
    }
    // Already signed in — no reason to show the form again.
    if (await hasValidSession(req, password)) {
      res.redirect(303, safeNext(req.query.next));
      return;
    }
    res.type('html').send(loginPage({ next: safeNext(req.query.next) }));
  });

  app.post('/login', loginLimiter, express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    const password = studioPassword();
    if (!password) {
      res.redirect(303, '/');
      return;
    }
    // A login form posted from another site is how someone gets silently signed into an
    // attacker-chosen session; the cookie is SameSite=Strict, but the POST itself still has to be
    // rejected.
    if (!originAllowed(req)) {
      res.status(403).type('html').send(loginPage({ error: 'That sign-in request did not come from this site.' }));
      return;
    }

    const body = req.body as { password?: unknown; next?: unknown };
    const candidate = typeof body.password === 'string' ? body.password : '';
    const next = safeNext(body.next);

    if (!secretsMatch(candidate, password)) {
      // Same message whether the field was empty or wrong: there is nothing useful to tell
      // someone who does not know the password, and a specific message helps them narrow it down.
      res.status(401).type('html').send(loginPage({ error: 'Wrong password. Please try again.', next }));
      return;
    }

    await issueSession(res, password);
    res.redirect(303, next);
  });

  app.use(async (req, res, next) => {
    const password = studioPassword();
    if (!password) {
      if (reachableFromElsewhere) {
        res
          .status(500)
          .send(
            'Studio is not configured: set STUDIO_PASSWORD before using this deployment. ' +
              'In the ZimaOS stack it comes from the .env file next to docker-compose.yml.',
          );
        return;
      }
      next();
      return;
    }

    if (PUBLIC_PATHS.has(req.path)) {
      next();
      return;
    }

    if (headerCredentialsMatch(req, password) || (await hasValidSession(req, password))) {
      next();
      return;
    }

    // A fetch() from an open editor whose session has just expired should get a JSON 401 its
    // error handling can show, not an HTML login page parsed as if it were data.
    if (expectsJson(req)) {
      res.status(401).json({ error: { message: 'Your session has expired — reload the page and sign in again' } });
      return;
    }

    // No WWW-Authenticate header: that is what triggers the browser's Basic-auth popup, and
    // replacing that popup with a real page is the point of this change.
    const target =
      req.originalUrl && req.originalUrl !== '/' ? `/login?next=${encodeURIComponent(req.originalUrl)}` : '/login';
    res.redirect(303, target);
  });

  /**
   * No longer linked from the topbar — the button was removed — but kept as the one way to end a
   * session without clearing cookies by hand or rotating SESSION_SECRET (which signs out every
   * device at once). SESSION_TTL_HOURS defaults to 720, so a session otherwise lasts 30 days.
   * verify-security.ts posts here directly and asserts the cookie comes back with Max-Age=0.
   */
  app.post('/logout', (_req, res) => {
    clearSession(res);
    res.redirect(303, '/login');
  });

  /**
   * Blocks state-changing requests that another site initiated. Everything below this point is
   * authenticated, so without it a malicious page could not read a problem but could still make a
   * logged-in author's browser delete one.
   */
  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    if (originAllowed(req)) {
      next();
      return;
    }
    res
      .status(403)
      .json({ error: { message: 'This request did not come from the studio (cross-site request blocked)' } });
  });

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
  const STATIC_PREFIXES = ['/assets/', '/studio-assets/', '/vendor/', '/favicon.ico', '/__live'];
  app.use((req, _res, next) => {
    if (!STATIC_PREFIXES.some((prefix) => req.path.startsWith(prefix))) {
      backgroundSync();
    }
    next();
  });

  // Rate limiting for heavy operations (PDF / Booklet / ZIP import): max 10 per minute per IP
  const heavyLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: { message: 'Too many heavy requests, please wait a minute and try again' } },
  });

  // ---------- Pages ----------
  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.get('/', (_req, res) => {
    res.type('html').send(dashboardPage());
  });

  app.get('/editor/:folder', async (req, res) => {
    let dir: string;
    try {
      // One query on this problem alone, so opening it reflects the database without paying for
      // a reconcile of everything.
      await ensureProblemCurrent(paramStr(req.params.folder));
      dir = resolveFolder(paramStr(req.params.folder));
    } catch {
      res.redirect('/');
      return;
    }
    const folder = path.basename(dir);
    const content = fs.readFileSync(path.join(dir, 'problem.yaml'), 'utf8');
    const check = checkProblem(dir);
    res.type('html').send(
      editorPage({
        folder,
        code: check.code ?? folder,
        name: check.name ?? folder,
        content,
      }),
    );
  });

  app.get('/preview/:folder', async (req, res) => {
    try {
      const dir = await resolveFolderPresent(paramStr(req.params.folder));
      // No asset pre-hydration here on purpose. The filename warning that used to fire falsely on
      // a cold instance is now handled where it belongs — render.ts asks durable storage directly
      // (see assetMayExistInStorage) — so every render path is covered, not just this one, and a
      // preview costs no extra query. The images themselves stay lazy: the browser's own request
      // for each one hydrates it via the /problem-assets route below.
      const { html } = renderProblem(dir, {
        live: true,
        showWarnings: true,
        assetsBasePath: `/problem-assets/${encodeURIComponent(paramStr(req.params.folder))}`,
      });
      res.type('html').send(html);
    } catch (err) {
      res.status(200).type('html').send(renderErrorPage(err, true));
    }
  });

  app.get('/__live-reload.js', (_req, res) => {
    res.type('js').send(LIVE_RELOAD_CLIENT);
  });

  // ---------- Static files ----------
  // Mounted before /assets so the fonts match here first and get the immutable policy; the
  // shorter /assets mount below still serves style.css with ordinary revalidation.
  app.use('/assets/fonts', express.static(path.join(ROOT, 'assets', 'fonts'), IMMUTABLE_ASSET));
  app.use('/assets', express.static(path.join(ROOT, 'assets')));
  app.use('/studio-assets', express.static(STUDIO_PUBLIC));
  app.use('/vendor/katex', express.static(KATEX_DIST, IMMUTABLE_ASSET));
  app.use('/vendor/hljs', express.static(HLJS_STYLES, IMMUTABLE_ASSET));

  app.get('/problem-assets/:folder/*splat', async (req, res) => {
    const folderParam = paramStr(req.params.folder);
    try {
      const dir = await resolveFolderPresent(folderParam);
      const splat = req.params.splat as string[] | string | undefined;
      const parts = Array.isArray(splat) ? splat : splat ? [splat] : [];
      if (parts.length === 0) {
        res.status(404).end();
        return;
      }
      const assetsDir = path.join(dir, 'assets');
      const target = path.normalize(path.join(assetsDir, ...parts));
      const assetsRoot = `${path.normalize(assetsDir)}${path.sep}`;
      // Path traversal guard: reject any resolved path that escapes assets/ (e.g. via ".." segments)
      if (!target.startsWith(assetsRoot)) {
        res.status(404).end();
        return;
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (target.toLowerCase().endsWith('.svg')) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }
      // Images are the bulk of the bytes, so they are never downloaded speculatively on a read
      // path. If this instance happens not to have one (uploaded elsewhere), fetch just that file.
      if (!fs.existsSync(target)) {
        const relative = ['assets', ...parts].join('/');
        if (!(await ensureAssetLocal(path.basename(dir), relative))) {
          // Logged because the browser only shows a broken image: a problem whose YAML points at
          // files the database never received (a partial restore, say) is otherwise invisible.
          console.warn(`[Assets] Not in the working copy or the database: ${path.basename(dir)}/${relative}`);
          res.status(404).end();
          return;
        }
      }
      // Relative to `root`, not the absolute path: `send` refuses (with a 404) any path containing a
      // dot-directory, and in the container the working copy lives under /app/.runtime. With a root
      // it only inspects the part of the path below assets/, which the guard above already bounds.
      res.sendFile(path.relative(assetsDir, target), { root: assetsDir }, (err) => {
        if (err && !res.headersSent) {
          console.warn(`[Assets] Could not send ${path.basename(dir)}/${parts.join('/')}: ${err.message}`);
          res.status(404).end();
        }
      });
    } catch (err) {
      // A bad or unknown folder name really is "not found". Anything else — the database being
      // unreachable, most likely — is an outage, and must not be passed off as a missing image.
      if (err instanceof ProblemError) {
        res.status(404).end();
        return;
      }
      console.error(`[Assets] Could not serve an image for "${folderParam}":`, err);
      res.status(503).end();
    }
  });

  // ---------- API ----------
  const api = express.Router();
  api.use(express.json({ limit: '2mb' }));

  api.get('/problems', handle(async (_req, res) => {
    // The dashboard defines what "exists", so it always asks the database rather than trusting
    // this instance's working copy. Forced, not TTL-coalesced: with a TTL, two refreshes seconds
    // apart could land on instances of different ages and report different problem counts.
    await syncFromStorage({ force: true });

    let dirs = listProblemDirs();
    const health = storageHealth();

    // Show only what the database actually holds. An instance whose reconcile failed still has
    // the seed problems baked into the deployment sitting in its working copy, and listing those
    // would present unrelated problems as if they were the project.
    if (isDbConfigured()) {
      const known = listKnownFolders();
      if (known) {
        dirs = dirs.filter((dir) => known.has(path.basename(dir)));
      } else {
        // The database is configured but has never answered, so this instance genuinely does not
        // know what exists. Showing the deployment's seed problems here would be presenting
        // unrelated content as the project; an explicit "cannot reach storage" is more honest.
        dirs = [];
      }
    }

    const problems = dirs.map(checkProblem).map(checkToListItem);
    // An empty list has two very different causes — nothing has been created yet, or the
    // database could not be reached. Say which, rather than showing "No problems yet" over what
    // is really an outage.
    const unknownStore = isDbConfigured() && !listKnownFolders();
    const warning = unknownStore
      ? 'Could not reach the database, so the problem list cannot be shown. Please reload in a moment.'
      : health.ok
        ? undefined
        : health.message;
    res.json({ problems, count: problems.length, max: MAX_PROBLEMS, warning });
  }));

  api.post('/problems', handle(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    // The database enforces both the MAX_PROBLEMS cap and name uniqueness atomically (one
    // statement, an advisory lock plus a real UNIQUE constraint — see createProblemInStorage), so
    // no in-process lock is needed here.
    const created = await createProblemInStorage(name);
    res.status(201).json({ folder: created.folder });
  }));

  api.get('/problems/:folder/yaml', handle(async (req, res) => {
    const folderParam = paramStr(req.params.folder);
    await ensureProblemCurrent(folderParam);
    const dir = resolveFolder(folderParam);
    const content = fs.readFileSync(path.join(dir, 'problem.yaml'), 'utf8');
    // version travels back on save so the server can tell whether this editor was looking at
    // the current file or at one somebody else has since changed
    res.json({ content, version: currentVersion(folderParam, content) });
  }));

  api.put('/problems/:folder/yaml', handle(async (req, res) => {
    const content = typeof req.body?.content === 'string' ? req.body.content : undefined;
    if (content === undefined) {
      throw new ProblemError('No content was provided to save');
    }
    const baseVersion = typeof req.body?.baseVersion === 'string' ? req.body.baseVersion : undefined;
    const folderParam = paramStr(req.params.folder);

    // Always save, whether the yaml is valid or not — so nothing typed is ever lost — then
    // report the validation result. One atomic UPDATE ... RETURNING when a database is
    // configured: the database itself serializes concurrent saves, and the returned version says
    // whether this save just overwrote one that was newer than what this editor last loaded.
    const { version, overwrote } = await saveProblemYamlInStorage(folderParam, content, baseVersion);
    const dir = resolveFolder(folderParam);
    const check = checkProblem(dir);
    res.json({
      ok: check.ok,
      code: check.code,
      name: check.name,
      warnings: check.warnings,
      error: check.error,
      version,
      overwrote,
    });
  }));

  api.delete('/problems/:folder', handle(async (req, res) => {
    const folder = paramStr(req.params.folder);
    await deleteProblemInStorage(folder);
    res.json({ ok: true, folder });
  }));

  api.get('/problems/:folder/assets', handle(async (req, res) => {
    const dir = await resolveFolderPresent(paramStr(req.params.folder));
    const folder = path.basename(dir);
    // The database is the durable source of truth for assets (see
    // saveAssetInStorage/deleteAssetInStorage); local disk only holds the images that have been
    // fetched into the working copy so far, so listing from it would hide the rest. Fall back to
    // the local listing only when no database is configured (local dev).
    if (isDbConfigured()) {
      const rows = await listAssetsInStorage(folder);
      const assets = rows
        .map((row) => assetInfo(folder, row.filename, row.size))
        .sort((a, b) => a.name.localeCompare(b.name, 'th'));
      res.json({ assets });
      return;
    }
    res.json({ assets: listProblemAssets(dir) });
  }));

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  api.post(
    '/problems/:folder/assets',
    (req: Request, res: Response, next: NextFunction) => {
      upload.single('file')(req, res, (err: unknown) => {
        if (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendError(
            res,
            new ProblemError('File upload failed', {
              details: [message],
              hint: 'The file may be larger than 10MB or was sent in an unexpected format',
            }),
          );
          return;
        }
        next();
      });
    },
    handle(async (req, res) => {
      const file = req.file;
      if (!file) {
        throw new ProblemError('No file was uploaded', { hint: 'Select an image file first, then try again' });
      }
      const dir = await resolveFolderPresent(paramStr(req.params.folder));
      const saved = saveProblemAsset(dir, file.originalname, file.buffer);
      // Push whatever was actually written to disk (post-SVG-sanitization), not the raw upload —
      // otherwise an unsanitized version could reach the database and be served to other instances.
      const writtenBytes = fs.readFileSync(path.join(dir, 'assets', saved.name));
      try {
        await saveAssetInStorage(path.basename(dir), saved.name, writtenBytes);
      } catch (err) {
        // The database push is the only durable copy (the container's disk is scratch space).
        // Leaving the local file in place after this fails would make the upload look successful
        // on this instance while the image silently 404s everywhere else — roll it back instead so
        // the failure the client is told about matches what actually happened.
        // Best effort rollback of the local write — the database push is what failed, so there is
        // no row to undo. A false return here just means the file was already gone.
        deleteProblemAsset(dir, saved.name);
        throw err;
      }
      res.status(201).json({ asset: saved });
    }),
  );

  api.delete('/problems/:folder/assets/:filename', handle(async (req, res) => {
    const dir = await resolveFolderPresent(paramStr(req.params.folder));
    const safeName = sanitizeAssetName(paramStr(req.params.filename));
    // The database decides whether this image existed, not local disk. The working copy is
    // scratch space in the container, so an image uploaded elsewhere — or before this instance cold
    // started — is legitimately absent from disk while still being present in the database.
    // Checking disk first made "delete image" fail with a bogus "not found in this problem" after
    // the app had been idle a while, and left the row orphaned because the row delete never ran.
    const removedRow = await deleteAssetInStorage(path.basename(dir), safeName);
    const removedFile = deleteProblemAsset(dir, safeName);
    if (!removedRow && !removedFile) {
      throw new ProblemError(`File "${safeName}" not found in this problem`, {
        hint: 'It may have already been deleted elsewhere — try refreshing this page',
      });
    }
    res.json({ ok: true });
  }));

  api.post('/problems/:folder/pdf', heavyLimiter, handle(async (req, res) => {
    const dir = await resolveFolderPresent(paramStr(req.params.folder));
    const browser = await getBrowser();
    const result = await exportProblemPdf(dir, browser);
    res.json({
      ok: true,
      code: result.code,
      name: result.name,
      warnings: result.warnings,
      downloadUrl: pdfDownloadUrl(paramStr(req.params.folder)),
    });
  }));

  api.get('/problems/:folder/pdf/file', handle(async (req, res) => {
    const dir = await resolveFolderPresent(paramStr(req.params.folder));
    const problem = loadProblem(dir);
    const file = path.join(DIST_DIR, `${problem.task.code}.pdf`);
    if (!fs.existsSync(file)) {
      throw new ProblemError('No PDF file has been generated for this problem yet', {
        hint: 'Click "Export PDF" first, then download it',
      });
    }
    res.download(file, `${problem.task.code}.pdf`);
  }));

  api.post('/export-all', heavyLimiter, handle(async (_req, res) => {
    const dirs = listProblemDirs();
    const browser = await getBrowser();
    const results: Array<{ folder: string; ok: boolean; code?: string; downloadUrl?: string; errorMessage?: string }> = [];

    for (const dir of dirs) {
      const folder = path.basename(dir);
      try {
        const result = await exportProblemPdf(dir, browser);
        results.push({ folder, ok: true, code: result.code, downloadUrl: pdfDownloadUrl(folder) });
      } catch (err) {
        const message =
          err instanceof ProblemError ? err.message : err instanceof Error ? err.message : String(err);
        results.push({ folder, ok: false, errorMessage: message });
      }
    }

    res.json({ results });
  }));

  api.post('/booklet', heavyLimiter, handle(async (req, res) => {
    const body = req.body || {};
    const folderNames: string[] | undefined = Array.isArray(body.folders) ? body.folders : undefined;

    let dirs: string[];
    if (folderNames && folderNames.length > 0) {
      // Resolve and validate selected folders
      dirs = await Promise.all(folderNames.map((f: string) => resolveFolderPresent(f)));
    } else {
      dirs = listProblemDirs();
    }

    const browser = await getBrowser();
    const options: import('./booklet.js').BookletOptions = {};
    if (typeof body.contestName === 'string' && body.contestName.trim()) options.contestName = body.contestName.trim();
    if (typeof body.logo === 'string' && body.logo.trim()) options.logo = body.logo.trim();
    if (typeof body.authors === 'string' && body.authors.trim()) options.authors = body.authors.trim();
    if (typeof body.rules === 'string' && body.rules.trim()) options.rules = body.rules.trim();

    const result = await buildBooklet(dirs, browser, undefined, Object.keys(options).length > 0 ? options : undefined);
    res.json({ ok: true, pageCount: result.pageCount, parts: result.parts, downloadUrl: '/api/booklet/file' });
  }));

  api.get('/booklet/file', handle((_req, res) => {
    const file = path.join(DIST_DIR, 'booklet.pdf');
    if (!fs.existsSync(file)) {
      throw new ProblemError('No combined booklet file has been generated yet', { hint: 'Click "Combine into one booklet" first, then download it' });
    }
    res.download(file, 'booklet.pdf');
  }));

  // ---------- ZIP export / import ----------

  // Export every problem as a single ZIP file
  api.get('/export-zip', handle(async (_req, res) => {
    const dirs = listProblemDirs();
    if (dirs.length === 0) {
      throw new ProblemError('There are no problems in the system, so a ZIP cannot be created');
    }
    const zip = new AdmZip();
    for (const dir of dirs) {
      const folderName = path.basename(dir);
      // addLocalFolder reads straight off local disk, and images are only fetched into the working
      // copy when something asks for them — hydrate first so the ZIP is never a silent partial
      // backup (see ensureAllAssetsLocal).
      await ensureAllAssetsLocal(folderName);
      zip.addLocalFolder(dir, folderName);
    }
    const buffer = zip.toBuffer();
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="problems-package-${dateStr}.zip"`);
    res.send(buffer);
  }));

  // Export a single problem as a ZIP
  api.get('/problems/:folder/export-zip', handle(async (req, res) => {
    const dir = await resolveFolderPresent(paramStr(req.params.folder));
    const folderName = path.basename(dir);
    // See the /export-zip handler above: hydrate from the database before reading local disk.
    await ensureAllAssetsLocal(folderName);
    const zip = new AdmZip();
    zip.addLocalFolder(dir, folderName);
    const buffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
    res.send(buffer);
  }));

  // Import problems from a ZIP file
  const uploadZip = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  });

  api.post(
    '/import-zip',
    heavyLimiter,
    (req: Request, res: Response, next: NextFunction) => {
      uploadZip.single('file')(req, res, (err: unknown) => {
        if (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendError(res, new ProblemError('ZIP file upload failed', { details: [message] }));
          return;
        }
        next();
      });
    },
    handle(async (req, res) => {
      const file = req.file;
      if (!file || !file.buffer) {
        throw new ProblemError('Please select a .zip file to import');
      }
      const mode = req.body?.mode === 'overwrite' ? 'overwrite' : 'add';

      await syncFromStorage({ force: true });
      const existing = isDbConfigured()
        ? (listKnownFolders() ?? new Set<string>())
        : new Set(listProblemDirs().map((d) => path.basename(d)));
      const parsed = parseProblemsZip(file.buffer, mode, existing);

      // Enforce MAX_PROBLEMS up front for the no-database path too (importParsedProblems
      // re-checks against the real count when a database is configured).
      if (!isDbConfigured() && existing.size + parsed.length > MAX_PROBLEMS) {
        throw new ProblemError(
          `Cannot import — this would put the total number of problems over the maximum of ${MAX_PROBLEMS} (currently ${existing.size}, adding ${parsed.length})`,
          { hint: `A maximum of ${MAX_PROBLEMS} problems is allowed. Please delete some problems you don't need before importing.` },
        );
      }

      await importParsedProblems(parsed, mode);
      const imported = parsed.map((p) => p.folder);
      res.json({ ok: true, count: imported.length, imported, mode });
    }),
  );

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
      if (browserPromise) {
        const browser = await browserPromise.catch(() => undefined);
        await browser?.close().catch(() => undefined);
      }
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
