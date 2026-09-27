/**
 * The sign-in gate: the login page, the check every later request passes through, sign-out, and
 * the cross-site request block. The session and password logic itself lives in src/auth.ts.
 *
 * Order matters, and this router keeps it: the login routes come before the gate (so they are
 * reachable signed out), sign-out comes after it, and the cross-site check comes last so it only
 * ever sees authenticated requests.
 */
import express, { type Request, type Router } from 'express';
// Named import (not default): some 8.x builds drop the `rateLimit as default` alias,
// which breaks the build with "no call signatures". The named export is stable across versions.
import { rateLimit } from 'express-rate-limit';
import {
  clearSession,
  hasValidSession,
  issueSession,
  originAllowed,
  secretsMatch,
  studioPassword,
} from '../auth.js';
import { loginPage } from '../studio-pages.js';

/** Paths that must work before anyone is logged in */
const PUBLIC_PATHS = new Set(['/favicon.ico', '/favicon.svg', '/healthz', '/login']);

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

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

/** `boundHostOption` is the address the server is listening on, when known — see StudioAppOptions */
export function authRoutes(boundHostOption: string | undefined): Router {
  const router = express.Router();

  // Whether an unauthenticated studio would be reachable by anyone but the person running it.
  // `npm run studio` on a laptop binds loopback and stays open, which is the single-user dev
  // convenience it has always been. Anything else — the container (NODE_ENV=production,
  // HOST=0.0.0.0), or a deliberate bind to a routable address — must have a password or refuse to
  // serve, because an open studio lets anyone who finds the URL read, rewrite and delete every
  // problem.
  // The bound address the caller told us about wins; process.env.HOST is only a fallback for
  // callers that create the app without listening themselves (the verification scripts).
  const boundHost = boundHostOption ?? process.env.HOST;
  const reachableFromElsewhere =
    process.env.NODE_ENV === 'production' ||
    Boolean(boundHost && !LOOPBACK.has(boundHost));

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

  router.get('/login', async (req, res) => {
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

  router.post('/login', loginLimiter, express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
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

  router.use(async (req, res, next) => {
    const password = studioPassword();
    if (!password) {
      if (reachableFromElsewhere) {
        res
          .status(500)
          .send(
            'Studio is not configured: set STUDIO_PASSWORD before using this deployment. ' +
              'With Docker Compose it comes from the .env file next to docker-compose.yml.',
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
  router.post('/logout', (_req, res) => {
    clearSession(res);
    res.redirect(303, '/login');
  });

  /**
   * Blocks state-changing requests that another site initiated. Everything below this point is
   * authenticated, so without it a malicious page could not read a problem but could still make a
   * logged-in author's browser delete one.
   */
  router.use((req, res, next) => {
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

  return router;
}
