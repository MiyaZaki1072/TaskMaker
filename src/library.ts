/**
 * The global library: images and text snippets shared by every problem, so a contest logo or the
 * standard rule text is saved once instead of re-uploaded / re-typed into each problem.
 *
 * Images are referenced *live* from problem.yaml as `global/<name>` (see toLibraryUrl in
 * render.ts), so replacing the logo here updates every problem, preview and PDF. Snippets are
 * plain text an author copies into a field — nothing in a problem refers back to them.
 *
 * Storage follows the same two modes as the problems themselves (storage-db.ts):
 *
 *   - no database: LIBRARY_DIR is the truth — images in images/, snippets in snippets.json
 *   - database: the library_images / library_snippets tables are the truth, and LIBRARY_DIR/cache
 *     only holds copies of image bytes
 *
 * Why the cache is keyed by content hash
 * --------------------------------------
 * Problem images are cached on disk by name and trusted once present (ensureAssetLocal). That is
 * wrong for the library, where replacing an image under the *same* name is the normal case: a
 * warm instance other than the one that took the upload would keep serving the old logo — or a
 * deleted one — until its container recycled. So every request for a library image asks the
 * database for the image's current hash (one primary-key lookup on a tiny table), and the cache
 * file is named `<hash>-<name>`. A stale copy can never answer for new content, and a deleted
 * image is a 404 however many copies of it are still on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { isDbConfigured, isUniqueViolation, sql } from './db.js';
import { ProblemError } from './errors.js';
import { contentVersion, writeFileAtomic } from './fs-atomic.js';
import { sanitizeAssetName, sanitizeSvg } from './problem-ops.js';
import { LIBRARY_DIR, listProblemDirs, setLibraryImageLookup } from './render.js';
import {
  contentTypeFor,
  ensureSchema,
  knownLibraryImageHash,
  rememberLibraryImage,
  storageHealth,
  syncFromStorage,
} from './storage-db.js';

/** Local mode: the images themselves */
const IMAGES_DIR = path.join(LIBRARY_DIR, 'images');
/** Database mode: `<hash>-<name>` copies of database rows */
const CACHE_DIR = path.join(LIBRARY_DIR, 'cache');
/** Local mode: every snippet, as one JSON array */
const SNIPPETS_FILE = path.join(LIBRARY_DIR, 'snippets.json');

/** contentVersion() is a 16-character hex digest — cache filenames rely on that fixed width */
const HASH_LENGTH = 16;

const SNIPPET_NAME_MAX = 80;
const SNIPPET_BODY_MAX = 20_000;

// ---------- images ----------

export interface LibraryImage {
  name: string;
  size: number;
  /** Changes whenever the bytes do; part of `url` so a replaced image is never served from a cache */
  version: string;
  url: string;
}

function libraryImageUrl(filename: string, version: string): string {
  return `/library-assets/${encodeURIComponent(filename)}?v=${encodeURIComponent(version)}`;
}

/** Local mode's version: the file's mtime, or null when the image does not exist */
function localVersion(filename: string): string | null {
  try {
    const stat = fs.statSync(path.join(IMAGES_DIR, filename));
    return stat.isFile() ? String(Math.floor(stat.mtimeMs)) : null;
  } catch {
    return null;
  }
}

// render.ts's `global/…` check. With a database it must never consult local disk: a leftover
// cached copy would otherwise hide the "not found" warning for an image deleted on another
// instance. Before the first reconcile the database answer is undefined, which render.ts treats
// as "probably fine" rather than crying wolf on every cold start.
setLibraryImageLookup((filename) => (isDbConfigured() ? knownLibraryImageHash(filename) : localVersion(filename)));

function cachePath(filename: string, hash: string): string {
  return path.join(CACHE_DIR, `${hash}-${filename}`);
}

/** Deletes this instance's cached copies of one image, except the one at `keepHash` (all when null) */
function pruneCache(filename: string, keepHash: string | null): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(CACHE_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry[HASH_LENGTH] !== '-' || entry.slice(HASH_LENGTH + 1) !== filename) continue;
    if (keepHash !== null && entry.slice(0, HASH_LENGTH) === keepHash) continue;
    try {
      fs.unlinkSync(path.join(CACHE_DIR, entry));
    } catch {
      /* another request got there first */
    }
  }
}

export async function listLibraryImages(): Promise<LibraryImage[]> {
  let images: LibraryImage[];
  if (!isDbConfigured()) {
    if (!fs.existsSync(IMAGES_DIR)) return [];
    images = fs
      .readdirSync(IMAGES_DIR, { withFileTypes: true })
      // Dotfiles are writeFileAtomic's in-flight temp files (and .gitkeep-style markers)
      .filter((entry) => entry.isFile() && !entry.name.startsWith('.'))
      .map((entry) => {
        const stat = fs.statSync(path.join(IMAGES_DIR, entry.name));
        const version = String(Math.floor(stat.mtimeMs));
        return { name: entry.name, size: stat.size, version, url: libraryImageUrl(entry.name, version) };
      });
  } else {
    await ensureSchema();
    const rows = (await sql()`
      SELECT filename, size, hash FROM library_images
    `) as unknown as Array<{ filename: string; size: number; hash: string }>;
    images = rows.map((row) => ({
      name: row.filename,
      size: row.size,
      version: row.hash,
      url: libraryImageUrl(row.filename, row.hash),
    }));
  }
  return images.sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

export interface ResolvedLibraryImage {
  /** Absolute path of a local file holding the image's current bytes */
  file: string;
  version: string;
}

/**
 * Finds the current bytes of one library image on local disk, fetching them from the database if
 * this instance has no copy of *this version*. Null when the library has no such image — even if
 * an old copy is still sitting in the cache.
 */
export async function resolveLibraryImage(filename: string): Promise<ResolvedLibraryImage | null> {
  if (!isDbConfigured()) {
    const version = localVersion(filename);
    return version === null ? null : { file: path.join(IMAGES_DIR, filename), version };
  }

  await ensureSchema();
  const rows = (await sql()`
    SELECT hash FROM library_images WHERE filename = ${filename}
  `) as unknown as Array<{ hash: string }>;
  const row = rows[0];
  if (!row) {
    rememberLibraryImage(filename, null);
    pruneCache(filename, null);
    return null;
  }
  rememberLibraryImage(filename, row.hash);
  const cached = cachePath(filename, row.hash);
  if (fs.existsSync(cached)) return { file: cached, version: row.hash };

  // The hash is read again alongside the bytes: the image may have been replaced between the two
  // queries, and the file must be named for the content it actually holds.
  const dataRows = (await sql()`
    SELECT data, hash FROM library_images WHERE filename = ${filename}
  `) as unknown as Array<{ data: string; hash: string }>;
  const current = dataRows[0];
  if (!current) {
    rememberLibraryImage(filename, null);
    pruneCache(filename, null);
    return null;
  }
  const file = cachePath(filename, current.hash);
  writeFileAtomic(file, Buffer.from(current.data, 'base64'));
  pruneCache(filename, current.hash);
  rememberLibraryImage(filename, current.hash);
  console.log(`[Library] Cached ${filename} (${current.hash}) from the database`);
  return { file, version: current.hash };
}

/**
 * Adds an image to the library, or replaces the one with the same name. Same filename rules and
 * SVG sanitization as problem images (problem-ops.ts).
 */
export async function saveLibraryImage(rawName: string, data: Buffer): Promise<LibraryImage> {
  const filename = sanitizeAssetName(rawName);
  const bytes = path.extname(filename).toLowerCase() === '.svg' ? sanitizeSvg(data) : data;

  if (!isDbConfigured()) {
    writeFileAtomic(path.join(IMAGES_DIR, filename), bytes);
    const version = localVersion(filename) ?? contentVersion(bytes);
    return { name: filename, size: bytes.length, version, url: libraryImageUrl(filename, version) };
  }

  await ensureSchema();
  const hash = contentVersion(bytes);
  const base64 = bytes.toString('base64');
  const contentType = contentTypeFor(filename);

  // Retried for the same reason as saveAssetInStorage: a transient blip must not turn into an
  // upload that looks fine now and is gone after the next restart.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await sql()`
        INSERT INTO library_images (filename, data, content_type, size, hash)
        VALUES (${filename}, ${base64}, ${contentType}, ${bytes.length}, ${hash})
        ON CONFLICT (filename) DO UPDATE
        SET data = EXCLUDED.data, content_type = EXCLUDED.content_type, size = EXCLUDED.size,
            hash = EXCLUDED.hash, updated_at = now()
      `;
      break;
    } catch (err) {
      if (isUniqueViolation(err) || attempt === MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }

  // Only cached once the database has it, so a failed push leaves nothing behind to roll back
  writeFileAtomic(cachePath(filename, hash), bytes);
  pruneCache(filename, hash);
  rememberLibraryImage(filename, hash);
  return { name: filename, size: bytes.length, version: hash, url: libraryImageUrl(filename, hash) };
}

export async function deleteLibraryImage(rawName: string): Promise<void> {
  const filename = sanitizeAssetName(rawName);
  let removed = false;

  if (!isDbConfigured()) {
    try {
      fs.unlinkSync(path.join(IMAGES_DIR, filename));
      removed = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  } else {
    await ensureSchema();
    const rows = (await sql()`
      DELETE FROM library_images WHERE filename = ${filename} RETURNING filename
    `) as unknown as Array<{ filename: string }>;
    removed = rows.length > 0;
    rememberLibraryImage(filename, null);
    pruneCache(filename, null);
  }

  if (!removed) {
    throw new ProblemError(`Image "${filename}" is not in the library`, {
      hint: 'It may have already been deleted elsewhere — reload this page',
    });
  }
}

/**
 * Express handler for GET /library-assets/:name — mounted by both the studio (studio-server.ts)
 * and the throwaway server Chromium renders PDFs through (server.ts), so preview, PDF, Export All
 * and the booklet all resolve `global/…` the same way.
 */
export async function serveLibraryAsset(req: Request, res: Response): Promise<void> {
  const param = req.params.name as string | string[] | undefined;
  const raw = Array.isArray(param) ? (param[0] ?? '') : (param ?? '');
  let filename: string;
  try {
    filename = sanitizeAssetName(raw);
  } catch {
    res.status(404).end();
    return;
  }
  // sanitizeAssetName keeps only the basename; a name it had to trim (e.g. "../x.png") was never
  // a library image, so it gets the same 404 as any other unknown name.
  if (filename !== raw) {
    res.status(404).end();
    return;
  }

  try {
    const found = await resolveLibraryImage(filename);
    if (!found) {
      res.status(404).end();
      return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Revalidated on every load (a cheap 304 via ETag): a replaced logo must show up straight
    // away. Rendered pages also add ?v=<hash>, which is what gets past Cloudflare.
    res.setHeader('Cache-Control', 'private, no-cache');
    if (filename.toLowerCase().endsWith('.svg')) {
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    }
    // Relative to `root` for the same reason as /problem-assets: in the container the cache sits
    // under /app/.runtime, and `send` 404s any absolute path through a dot-directory.
    res.sendFile(path.basename(found.file), { root: path.dirname(found.file), cacheControl: false }, (err) => {
      if (err && !res.headersSent) {
        console.warn(`[Library] Could not send ${filename}: ${err.message}`);
        res.status(404).end();
      }
    });
  } catch (err) {
    // Unknown name is a 404 above; reaching here means the database is unreachable — an outage,
    // not a missing image.
    console.error(`[Library] Could not serve "${filename}":`, err);
    res.status(503).end();
  }
}

// ---------- references from problems ----------

/**
 * `global/<name>` as it appears in problem.yaml text — `logo: "global/x.png"`,
 * `[img: global/x.png | caption]`, `image: ./global/x.png`. The lookbehind is what keeps
 * `assets/global/x.png` (an ordinary problem image) out, matching GLOBAL_REF_RE in render.ts.
 */
const GLOBAL_REF_IN_YAML_RE = /(?<![\w./-])(?:\.\/)?global\/([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/g;

/** Every distinct library image name a problem.yaml refers to */
export function findGlobalRefs(yaml: string): string[] {
  return [...new Set(Array.from(yaml.matchAll(GLOBAL_REF_IN_YAML_RE), (m) => m[1]!))];
}

/** The problem folders whose problem.yaml refers to this library image */
export async function libraryImageUsage(rawName: string): Promise<string[]> {
  const filename = sanitizeAssetName(rawName);
  // Forced, not TTL-coalesced: this answers "is it safe to delete?", and a working copy a few
  // seconds behind the database could say "used by nothing" about the logo on every problem.
  await syncFromStorage({ force: true });
  const health = storageHealth();
  if (!health.ok) {
    throw new ProblemError('Could not check which problems use this image', {
      details: health.message ? [health.message] : [],
      hint: 'Try again in a moment',
    });
  }
  const folders: string[] = [];
  for (const dir of listProblemDirs()) {
    try {
      if (findGlobalRefs(fs.readFileSync(path.join(dir, 'problem.yaml'), 'utf8')).includes(filename)) {
        folders.push(path.basename(dir));
      }
    } catch {
      /* deleted while we were looking */
    }
  }
  return folders;
}

/** `global-logo.png`, then `global-logo-2.png`, … — undefined if no free name passes the filename rules */
function freeAssetName(candidate: string, taken: Set<string>): string | undefined {
  const ext = path.extname(candidate);
  const base = candidate.slice(0, candidate.length - ext.length);
  for (let i = 1; i < 100; i += 1) {
    const name = i === 1 ? candidate : `${base}-${i}${ext}`;
    try {
      sanitizeAssetName(name);
    } catch {
      return undefined;
    }
    if (!taken.has(name.toLowerCase())) return name;
  }
  return undefined;
}

export interface FlattenedProblem {
  yaml: string;
  /** Files to add under the problem's assets/ folder in the export */
  files: Array<{ filename: string; data: Buffer }>;
}

/**
 * For ZIP export: turns a problem's live `global/…` references into ordinary problem images, so
 * the exported package is complete on its own — on another studio, or after the library image is
 * gone. Each referenced image is copied as `assets/global-<name>` and the YAML is rewritten to
 * point there. Only the export changes; the problem in the studio keeps its live link.
 *
 * A reference to an image the library does not have is left untouched — the render warning
 * already reports it, and there is nothing to copy.
 */
export async function flattenGlobalRefs(yaml: string, existingAssets: Iterable<string>): Promise<FlattenedProblem> {
  const names = findGlobalRefs(yaml);
  if (names.length === 0) return { yaml, files: [] };

  // Case-insensitive: the ZIP may be unpacked on Windows or macOS, where Logo.png and logo.png collide
  const taken = new Set(Array.from(existingAssets, (name) => name.toLowerCase()));
  const renamed = new Map<string, string>();
  const files: FlattenedProblem['files'] = [];
  for (const name of names) {
    const found = await resolveLibraryImage(name);
    if (!found) continue;
    const target = freeAssetName(`global-${name}`, taken);
    if (!target) continue;
    taken.add(target.toLowerCase());
    renamed.set(name, target);
    files.push({ filename: target, data: fs.readFileSync(found.file) });
  }

  const rewritten = yaml.replace(GLOBAL_REF_IN_YAML_RE, (match, name: string) => {
    const target = renamed.get(name);
    return target ? `assets/${target}` : match;
  });
  return { yaml: rewritten, files };
}

// ---------- snippets ----------

export interface Snippet {
  name: string;
  body: string;
}

function validateSnippet(input: unknown): Snippet {
  const obj = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name.trim() : '';
  const body = typeof obj.body === 'string' ? obj.body.replace(/\r\n/g, '\n') : '';
  if (!name) {
    throw new ProblemError('The snippet needs a name', { hint: 'e.g. "Contest rules"' });
  }
  if (name.length > SNIPPET_NAME_MAX) {
    throw new ProblemError(`The snippet name is too long (max ${SNIPPET_NAME_MAX} characters)`);
  }
  if (!body.trim()) {
    throw new ProblemError('The snippet is empty', { hint: 'Type the text you want to reuse, then save' });
  }
  if (body.length > SNIPPET_BODY_MAX) {
    throw new ProblemError(`The snippet is too long (max ${SNIPPET_BODY_MAX.toLocaleString('en')} characters)`);
  }
  return { name, body };
}

function duplicateSnippet(name: string): ProblemError {
  return new ProblemError(`A snippet named "${name}" already exists`, {
    hint: 'Pick a different name, or edit the existing snippet instead',
  });
}

function snippetNotFound(): ProblemError {
  return new ProblemError('Snippet not found', { hint: 'It may have been deleted elsewhere — reload this page' });
}

function sortSnippets(list: Snippet[]): Snippet[] {
  return list.sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

function readLocalSnippets(): Snippet[] {
  let raw: string;
  try {
    raw = fs.readFileSync(SNIPPETS_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    throw new ProblemError('The snippets file is damaged and could not be read', {
      file: SNIPPETS_FILE,
      hint: 'Fix or delete library/snippets.json, then reload this page',
    });
  }
  return parsed.filter(
    (s): s is Snippet => !!s && typeof s === 'object' && typeof s.name === 'string' && typeof s.body === 'string',
  );
}

function writeLocalSnippets(list: Snippet[]): void {
  writeFileAtomic(SNIPPETS_FILE, `${JSON.stringify(sortSnippets(list), null, 2)}\n`);
}

export async function listSnippets(): Promise<Snippet[]> {
  if (!isDbConfigured()) return sortSnippets(readLocalSnippets());
  await ensureSchema();
  const rows = (await sql()`SELECT name, body FROM library_snippets`) as unknown as Snippet[];
  return sortSnippets(rows);
}

export async function createSnippet(input: unknown): Promise<Snippet> {
  const snippet = validateSnippet(input);
  if (!isDbConfigured()) {
    const list = readLocalSnippets();
    if (list.some((s) => s.name === snippet.name)) throw duplicateSnippet(snippet.name);
    writeLocalSnippets([...list, snippet]);
    return snippet;
  }
  await ensureSchema();
  try {
    await sql()`INSERT INTO library_snippets (name, body) VALUES (${snippet.name}, ${snippet.body})`;
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateSnippet(snippet.name);
    throw err;
  }
  return snippet;
}

/** Saves a snippet's text, renaming it too when `input.name` differs from `currentName` */
export async function updateSnippet(currentName: string, input: unknown): Promise<Snippet> {
  const snippet = validateSnippet(input);
  if (!isDbConfigured()) {
    const list = readLocalSnippets();
    const index = list.findIndex((s) => s.name === currentName);
    if (index === -1) throw snippetNotFound();
    if (snippet.name !== currentName && list.some((s) => s.name === snippet.name)) throw duplicateSnippet(snippet.name);
    list[index] = snippet;
    writeLocalSnippets(list);
    return snippet;
  }
  await ensureSchema();
  let rows: Array<{ name: string }>;
  try {
    // One statement renames and edits together; Postgres enforces the new name's uniqueness
    rows = (await sql()`
      UPDATE library_snippets SET name = ${snippet.name}, body = ${snippet.body}, updated_at = now()
      WHERE name = ${currentName}
      RETURNING name
    `) as unknown as Array<{ name: string }>;
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateSnippet(snippet.name);
    throw err;
  }
  if (rows.length === 0) throw snippetNotFound();
  return snippet;
}

export async function deleteSnippet(name: string): Promise<void> {
  if (!isDbConfigured()) {
    const list = readLocalSnippets();
    const remaining = list.filter((s) => s.name !== name);
    if (remaining.length === list.length) throw snippetNotFound();
    writeLocalSnippets(remaining);
    return;
  }
  await ensureSchema();
  const rows = (await sql()`
    DELETE FROM library_snippets WHERE name = ${name} RETURNING name
  `) as unknown as Array<{ name: string }>;
  if (rows.length === 0) throw snippetNotFound();
}
