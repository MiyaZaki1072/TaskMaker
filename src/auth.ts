/**
 * Login and session handling for the studio.
 *
 * What this replaces
 * ------------------
 * The old gate was HTTP Basic: the browser's grey popup, the password re-sent in a header on
 * every single request, no way to log out short of closing the browser, and no way to present a
 * decent error. That was tolerable when the deployment was a private URL nobody shared. This one is
 * published on a real domain through a Cloudflare tunnel, so it gets a real login page and a
 * signed session cookie instead.
 *
 * Still one shared password, deliberately — this is a small studio with a handful of trusted
 * authors, and accounts would mean invite flows, password resets and an email server on a box
 * that has none. What changed is everything around the password:
 *
 *   - it is compared in constant time, so the comparison cannot be used to guess it piece by piece
 *   - failed attempts are rate limited per IP (see studio-server.ts)
 *   - the browser holds a signed, expiring token rather than the password itself, so a session
 *     can be revoked and the password is not sitting in the browser's credential store
 *   - changing STUDIO_PASSWORD invalidates every existing session, because the password's
 *     fingerprint is part of what the token commits to
 *
 * The session is stateless: the cookie carries its own expiry and an HMAC over it, so there is no
 * sessions table to keep, nothing to clean up, and a restart does not log everyone out.
 */
import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { isDbConfigured, sql } from './db.js';
import { initSchema } from './storage-db.js';

const COOKIE_NAME = 'studio_session';
const DEFAULT_TTL_HOURS = 24 * 30;

export function studioPassword(): string | undefined {
  const password = process.env.STUDIO_PASSWORD;
  return password && password.length > 0 ? password : undefined;
}

/**
 * Cookies must be marked Secure when the browser sees HTTPS, and must not be when it sees plain
 * HTTP — a Secure cookie on an http:// page is silently dropped, which presents as "I type the
 * right password and the login page just comes back". Behind the Cloudflare tunnel the browser
 * always sees HTTPS even though this process only speaks HTTP, so this cannot be detected from
 * the socket and has to be configuration.
 */
function secureCookies(): boolean {
  return process.env.SECURE_COOKIES !== '0';
}

function ttlMs(): number {
  const hours = Number(process.env.SESSION_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS) * 3600 * 1000;
}

/**
 * Compares two secrets without leaking their contents through how long the comparison takes.
 *
 * Both sides are hashed first so that timingSafeEqual always gets two equal-length buffers: it
 * throws on a length mismatch, and catching that would itself reveal whether the guess was the
 * right length.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Short digest of the current password, so rotating it invalidates every issued session */
function passwordFingerprint(password: string): string {
  return crypto.createHash('sha256').update(`pw:${password}`, 'utf8').digest('hex').slice(0, 16);
}

// ---------- session secret ----------

/**
 * The HMAC key the session cookie is signed with.
 *
 * Preference order, and why:
 *   1. SESSION_SECRET, if set — lets an operator rotate it deliberately (restart = everyone out)
 *   2. a value generated once and kept in Postgres — so that by default nobody has to invent and
 *      manage a second secret, and logins still survive a container restart. A secret held only
 *      in memory would log everyone out on every deploy, which trains people to expect the login
 *      page and makes a real session failure invisible.
 *   3. a random value for this process — only when there is no database at all, i.e. local
 *      `npm run studio`, where losing sessions on restart costs nothing.
 */
let secretPromise: Promise<Buffer> | undefined;

async function loadSessionSecret(): Promise<Buffer> {
  const configured = process.env.SESSION_SECRET;
  if (configured && configured.length > 0) return Buffer.from(configured, 'utf8');

  if (!isDbConfigured()) return crypto.randomBytes(32);

  try {
    await initSchema();
    const generated = crypto.randomBytes(32).toString('hex');
    // One statement, so two containers starting at once cannot both think they created it: the
    // loser's INSERT does nothing and the RETURNING clause hands it the winner's value.
    const rows = (await sql()`
      INSERT INTO storage_meta (key, value) VALUES ('session_secret', ${generated})
      ON CONFLICT (key) DO UPDATE SET value = storage_meta.value
      RETURNING value
    `) as unknown as Array<{ value: string }>;
    const stored = rows[0]?.value;
    if (stored) return Buffer.from(stored, 'utf8');
  } catch (err) {
    console.error('[Auth] Could not read the stored session secret, using a temporary one:', err);
  }
  // Falling back keeps the studio usable (you can still log in); the only cost is that sessions
  // do not survive a restart until the database is reachable again.
  return crypto.randomBytes(32);
}

export function sessionSecret(): Promise<Buffer> {
  if (!secretPromise) secretPromise = loadSessionSecret();
  return secretPromise;
}

// ---------- token ----------

function sign(payload: string, secret: Buffer): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function makeToken(password: string, secret: Buffer): string {
  const payload = Buffer.from(
    JSON.stringify({ v: passwordFingerprint(password), exp: Date.now() + ttlMs() }),
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function tokenIsValid(token: string, password: string, secret: Buffer): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  const expected = sign(payload, secret);
  // Same length by construction (both are base64url of a SHA-256 digest), but a truncated cookie
  // would still reach here, so guard rather than let timingSafeEqual throw.
  if (signature.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      v?: unknown;
      exp?: unknown;
    };
    if (typeof decoded.exp !== 'number' || Date.now() > decoded.exp) return false;
    // Rotating STUDIO_PASSWORD changes this, which is what makes "change the password" also mean
    // "log everyone out" — otherwise a session issued under the old password would outlive it.
    return decoded.v === passwordFingerprint(password);
  } catch {
    return false;
  }
}

// ---------- cookies ----------

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

function cookieAttributes(maxAgeSeconds: number): string {
  const parts = [
    'Path=/',
    'HttpOnly', // not readable from JavaScript, so an XSS bug cannot steal the session
    'SameSite=Strict', // the browser will not send it on a request another site initiated
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secureCookies()) parts.push('Secure');
  return parts.join('; ');
}

export async function issueSession(res: Response, password: string): Promise<void> {
  const token = makeToken(password, await sessionSecret());
  res.append('Set-Cookie', `${COOKIE_NAME}=${token}; ${cookieAttributes(Math.floor(ttlMs() / 1000))}`);
}

export function clearSession(res: Response): void {
  res.append('Set-Cookie', `${COOKIE_NAME}=; ${cookieAttributes(0)}`);
}

export async function hasValidSession(req: Request, password: string): Promise<boolean> {
  const token = readCookie(req, COOKIE_NAME);
  if (!token) return false;
  return tokenIsValid(token, password, await sessionSecret());
}

// ---------- CSRF ----------

/**
 * Whether a state-changing request came from this site.
 *
 * SameSite=Strict on the session cookie already stops a browser sending it on a cross-site
 * request, which covers classic CSRF. This is the second lock: it checks the Origin header, which
 * browsers set on every fetch() and form POST and which page JavaScript cannot forge.
 *
 * Doing it here rather than with a per-form token is a deliberate trade: a token would mean
 * threading a value through every fetch() in dashboard.js and editor.js, and a missed call site
 * fails closed in a way that looks like a broken button. This check needs no client changes.
 *
 * A request with no Origin at all is allowed: non-browser clients (curl, the export scripts) do
 * not send one, and they authenticate with the X-Studio-Password header rather than a cookie, so
 * they were never what CSRF protects against.
 */
export function originAllowed(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true;

  const allowed = new Set<string>();
  const configured = process.env.PUBLIC_ORIGIN;
  if (configured) allowed.add(configured.replace(/\/$/, ''));

  // Also accept the host the request itself was addressed to, so reaching the studio directly on
  // the LAN keeps working when PUBLIC_ORIGIN names only the tunnel's hostname.
  const host = req.get('host');
  if (host) {
    allowed.add(`http://${host}`);
    allowed.add(`https://${host}`);
  }

  return allowed.has(origin.replace(/\/$/, ''));
}
