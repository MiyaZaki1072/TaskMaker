/**
 * Durable storage for the problem set, in Postgres. The connection is made in db.ts — a plain
 * `pg` pool pointed at the Postgres container in the docker-compose stack.
 *
 * The database is what keeps concurrent edits honest:
 *
 *   - Uniqueness and the MAX_PROBLEMS cap are enforced by the database in one atomic statement
 *     (a real UNIQUE constraint + an advisory lock around the count check), not by a filesystem
 *     existence check that two requests could both pass.
 *   - A save is one `UPDATE … RETURNING version`. The returned version tells us both the new
 *     state and whether we just overwrote someone else's newer save — no separate etag, no
 *     separate "did it change" round trip.
 *   - A conflict is a real Postgres error code (23505 unique_violation), not a guess based on
 *     matching an error message string.
 *
 * The working copy
 * ----------------
 * The database is the source of truth; the app also keeps a working copy under PROBLEMS_DIR so
 * the filesystem-based render/PDF pipeline (render.ts, booklet.ts, pdf-export.ts) can read plain
 * files. That copy is scratch space, rebuilt from the database on boot. Reads stay off the
 * request's critical path: a background nudge keeps it roughly current, and the routes that need
 * freshness (opening a problem, saving, the dashboard listing) ask for exactly what they need.
 *
 * Image bytes are stored as base64 TEXT, not bytea, so a backup is a plain-text SQL dump that
 * restores with no type conversion step to get wrong. The cost is ~33% more bytes on the wire —
 * a non-issue at this project's scale (at most 15 problems, a few small images each).
 */
import fs from 'node:fs';
import path from 'node:path';
import { isDbConfigured, isForeignKeyViolation, isUniqueViolation, sql, type PendingQuery } from './db.js';
import { ProblemError } from './errors.js';
import { contentVersion, writeFileAtomic } from './fs-atomic.js';
import {
  buildBlankProblemYaml,
  createProblem as createProblemLocal,
  MAX_PROBLEMS,
  materializeProblemFiles,
  type CreatedProblem,
} from './problem-ops.js';
import { listProblemDirs, PROBLEMS_DIR, PROBLEMS_DIR_DISPOSABLE, setStorageAssetLookup } from './render.js';

/** How long a full listing counts as current, so a burst of requests shares one query */
const REFRESH_TTL_MS = 5_000;

// Connection handling, the tagged-template query API and the Postgres error-code checks all live
// in db.ts now. isDbConfigured is re-exported because it is part of this module's public surface
// (studio-server.ts and scripts/db-init.ts both ask it "is there a database?").
export { isDbConfigured };

/** Raised when a create loses a race to another user picking the same problem name */
export class StorageConflictError extends Error {}

/** noUncheckedIndexedAccess makes rows[0] "possibly undefined" even right after a length check; this documents why it never actually is here */
function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (row === undefined) throw new Error('Expected at least one row back from the database');
  return row;
}

async function countProblems(): Promise<number> {
  const rows = (await sql()`SELECT count(*)::int AS n FROM problems`) as unknown as Array<{ n: number }>;
  return firstRow(rows).n;
}

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};
function contentTypeFor(filename: string): string {
  return CONTENT_TYPES[path.extname(filename).toLowerCase()] ?? 'application/octet-stream';
}

// ---------- schema ----------

let schemaReady: Promise<void> | undefined;

/** Idempotent: safe to call on every cold start. See also `npm run db:init` for an explicit check. */
async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q = sql();
      await q`
        CREATE TABLE IF NOT EXISTS problems (
          folder TEXT PRIMARY KEY,
          yaml TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await q`
        CREATE TABLE IF NOT EXISTS problem_assets (
          folder TEXT NOT NULL REFERENCES problems(folder) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          data TEXT NOT NULL,
          content_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (folder, filename)
        )
      `;
      // Tracks one-time storage facts — currently just whether the local-checkout seed problems
      // have ever been pushed up. Row count alone can't answer that: a database a user has since
      // emptied by deleting every problem looks identical to one that was never seeded.
      await q`
        CREATE TABLE IF NOT EXISTS storage_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `;
    })().catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  }
  return schemaReady;
}

/** For `npm run db:init` — ensures the schema exists and reports success, without hydrating anything */
export async function initSchema(): Promise<void> {
  await ensureSchema();
}

// ---------- local materialization ----------

function yamlPath(folder: string): string {
  return path.join(PROBLEMS_DIR, folder, 'problem.yaml');
}
function assetPath(folder: string, filename: string): string {
  return path.join(PROBLEMS_DIR, folder, 'assets', filename);
}

/** folder -> version currently on local disk, so an unchanged problem is not rewritten every call */
const localVersions = new Map<string, number>();

function materializeProblem(folder: string, yaml: string, version: number): void {
  writeFileAtomic(yamlPath(folder), yaml);
  localVersions.set(folder, version);
}

function removeLocalProblem(folder: string): void {
  try {
    fs.rmSync(path.join(PROBLEMS_DIR, folder), { recursive: true, force: true });
  } catch {
    /* already gone */
  }
  localVersions.delete(folder);
}

// ---------- reading ----------

let knownFolders: Set<string> | undefined;
let lastFullSync = 0;
let lastSyncError: string | undefined;

/** The folder names the database is known to hold, or undefined if we have never managed to ask */
export function listKnownFolders(): Set<string> | undefined {
  if (!isDbConfigured()) return undefined;
  return knownFolders;
}

/**
 * folder -> the image filenames the database holds for it. Filenames only, never the base64 bytes,
 * so keeping this current costs one small query per reconcile.
 *
 * This exists so render.ts's "is this image filename a typo?" check has something authoritative to
 * ask synchronously. renderProblem() is sync and runs on several paths (the editor page, the
 * dashboard listing, every save's re-check, the preview), so it cannot await a fetch — and if it
 * consults only local disk it cries wolf on every cold instance, because the working copy is
 * per-instance while the database is shared. Pre-hydrating each call site was tried and did not
 * hold: a path was missed, the false warning came straight back, and nothing stopped the next new
 * render path from missing it too.
 */
const knownAssets = new Map<string, Set<string>>();

/**
 * Whether the database may hold this image. Deliberately errs toward "yes":
 *   - no database configured -> "no", because then local disk really is the whole truth
 *   - this folder's list not loaded yet -> "yes", so a not-yet-reconciled instance stays quiet
 *     rather than warning about an image that is very likely fine
 * Missing a typo warning is a small cost; crying wolf about intact images is the bug being fixed.
 */
export function assetMayExistInStorage(folder: string, filename: string): boolean {
  if (!isDbConfigured()) return false;
  const known = knownAssets.get(folder);
  if (!known) return true;
  return known.has(filename);
}

setStorageAssetLookup(assetMayExistInStorage);

function rememberAsset(folder: string, filename: string): void {
  const known = knownAssets.get(folder);
  if (known) known.add(filename);
}

function forgetAsset(folder: string, filename: string): void {
  knownAssets.get(folder)?.delete(filename);
}

export function storageHealth(): { ok: boolean; message?: string } {
  if (!isDbConfigured()) return { ok: true };
  if (lastSyncError) return { ok: false, message: `Could not reach the database: ${lastSyncError}` };
  return { ok: true };
}

interface ProblemRow {
  folder: string;
  yaml: string;
  version: number;
}

// Orders reconciles by when they *started*, not when their DB round trip happened to land, so a
// forced reconcile that began before a delete can never overwrite one that began after it just
// because its query came back slower. Both counters are per-instance in-memory state, which is
// exactly the scope of the race: two reconciles only ever race each other within the same warm
// process, since knownFolders/localVersions are themselves per-instance. A cold start resets both
// to 0 along with the caches they guard, so this needs no cross-instance coordination.
let reconcileSeq = 0;
let appliedSeq = 0;

/** Full reconcile: one query returns every problem's content and version, always fully consistent */
async function reconcile(): Promise<void> {
  await ensureSchema();
  const seq = ++reconcileSeq;
  const rows = (await sql()`SELECT folder, yaml, version FROM problems ORDER BY folder`) as unknown as ProblemRow[];

  // A newer reconcile (higher seq) already landed while this one's query was still in flight —
  // applying this stale result now would resurrect whatever it saw before that newer one's writes
  // (e.g. a since-deleted problem), which is precisely the "delete it, refresh, it's back" bug.
  if (seq <= appliedSeq) return;
  appliedSeq = seq;

  // Deliberately materializes problem.yaml only, never assets: assets are handled lazily by
  // ensureAssetLocal (one file, fetched only when something actually requests it) plus
  // ensureAllAssetsLocal for the one bulk-read case that needs every file up front (ZIP export).
  // Eagerly pulling every asset for every problem here would mean every cold instance pays a full
  // asset download on first request even for problems nobody is actively opening — the lazy paths
  // already cover the failure modes this project has actually hit (see listAssetsInStorage and
  // ensureAllAssetsLocal) without that cost.
  const remote = new Set<string>();
  for (const row of rows) {
    remote.add(row.folder);
    if (localVersions.get(row.folder) !== row.version || !fs.existsSync(yamlPath(row.folder))) {
      materializeProblem(row.folder, row.yaml, row.version);
    }
  }
  knownFolders = remote;

  // Refresh the synchronous asset-name view that render.ts's filename check reads (see
  // knownAssets). Filenames and folders only — no `data` column, so this stays cheap enough to do
  // on every reconcile, which is what keeps the check from going stale and warning about images
  // that are perfectly fine.
  const assetRows = (await sql()`
    SELECT folder, filename FROM problem_assets
  `) as unknown as Array<{ folder: string; filename: string }>;
  const remoteAssets = new Map<string, Set<string>>();
  for (const folder of remote) remoteAssets.set(folder, new Set());
  for (const row of assetRows) {
    let set = remoteAssets.get(row.folder);
    if (!set) {
      set = new Set();
      remoteAssets.set(row.folder, set);
    }
    set.add(row.filename);
  }
  knownAssets.clear();
  for (const [folder, names] of remoteAssets) knownAssets.set(folder, names);

  // Deleting local files is only safe on a disposable working copy (the container's, or an explicit
  // test opt-in — see PROBLEMS_DIR_DISPOSABLE). Run this against a real checkout and the database
  // being the "authority" would delete uncommitted work that simply has not been pushed yet.
  if (PROBLEMS_DIR_DISPOSABLE && fs.existsSync(PROBLEMS_DIR)) {
    for (const entry of fs.readdirSync(PROBLEMS_DIR, { withFileTypes: true })) {
      if (entry.isDirectory() && !remote.has(entry.name)) {
        removeLocalProblem(entry.name);
      }
    }
  }
}

/**
 * Brings the whole working copy in line with the database. TTL-coalesced so a burst of requests
 * shares one query. A failure is logged, not thrown — serving the last known-good working copy
 * beats failing a page load outright.
 */
let syncInFlight: Promise<void> | undefined;
export async function syncFromStorage(options: { force?: boolean } = {}): Promise<void> {
  if (!isDbConfigured()) return;
  if (!options.force) {
    if (Date.now() - lastFullSync < REFRESH_TTL_MS) return;
    if (syncInFlight) return syncInFlight;
  }

  const run = reconcile()
    .then(() => {
      lastSyncError = undefined;
    })
    .catch((err) => {
      lastSyncError = err instanceof Error ? err.message : String(err);
      console.error('[Storage] Reconcile with the database failed:', err);
    })
    .finally(() => {
      lastFullSync = Date.now();
      if (syncInFlight === run) syncInFlight = undefined;
    });
  syncInFlight = run;
  return run;
}

let backgroundRunning = false;
/** Kicks off a refresh without blocking the caller — never awaited on a request's critical path */
export function backgroundSync(): void {
  if (!isDbConfigured()) return;
  if (backgroundRunning || Date.now() - lastFullSync < REFRESH_TTL_MS) return;
  backgroundRunning = true;
  void syncFromStorage()
    .catch(() => undefined)
    .finally(() => {
      backgroundRunning = false;
    });
}

/**
 * Makes sure one problem's content matches the database, fetching it only if the locally cached
 * version is stale or missing. Costs one small query (the row is a few KB of YAML text at most)
 * — no separate "check" step, unlike the Blob version's head()+get() dance, because there is no
 * CDN staleness to guard against here.
 */
export async function ensureProblemCurrent(folder: string): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const rows = (await sql()`SELECT yaml, version FROM problems WHERE folder = ${folder}`) as unknown as Array<{
    yaml: string;
    version: number;
  }>;
  if (rows.length === 0) {
    // Deleted on another instance — drop the local copy so the UI says "not found" instead of
    // letting someone edit a problem that no longer exists.
    knownFolders?.delete(folder);
    removeLocalProblem(folder);
    return;
  }
  const { yaml, version } = firstRow(rows);
  if (localVersions.get(folder) !== version || !fs.existsSync(yamlPath(folder))) {
    materializeProblem(folder, yaml, version);
  }
}

/**
 * The version string for one problem's current content, for the read side of the same contract
 * saveProblemYamlInStorage returns from the write side (GET .../yaml returns this; PUT .../yaml
 * sends it back as baseVersion). When a database is configured this is the real integer version
 * tracked locally after the last sync with it; otherwise it falls back to a content hash, there
 * being no real version number to consult without one.
 */
export function currentVersion(folder: string, content: string): string {
  if (isDbConfigured()) {
    const v = localVersions.get(folder);
    if (v !== undefined) return String(v);
  }
  return contentVersion(content);
}

/**
 * Makes sure one problem exists in the working copy at all, fetching it only if missing. Free in
 * the common case — the file is already there. Used by routes (PDF export, preview, ZIP export)
 * that only care about existence, not staleness.
 */
export async function ensureProblemPresent(folder: string): Promise<void> {
  if (!isDbConfigured()) return;
  if (fs.existsSync(yamlPath(folder))) return;
  await ensureProblemCurrent(folder);
}

/** Fetches one asset on demand, for a request that wants an image this instance does not have locally */
export async function ensureAssetLocal(folder: string, relative: string): Promise<boolean> {
  const local = path.join(PROBLEMS_DIR, folder, ...relative.split('/'));
  if (fs.existsSync(local)) return true;
  if (!isDbConfigured()) return false;
  const filename = relative.replace(/^assets\//, '');
  await ensureSchema();
  const rows = (await sql()`
    SELECT data FROM problem_assets WHERE folder = ${folder} AND filename = ${filename}
  `) as unknown as Array<{ data: string }>;
  if (rows.length === 0) return false;
  // The only signal we have for how often instances actually drift apart: a healthy
  // single-instance dev box should never print this, since the file would already be on disk.
  console.log(`[Storage] Local cache miss, fetched from database: ${folder}/${filename}`);
  writeFileAtomic(local, Buffer.from(firstRow(rows).data, 'base64'));
  return true;
}

/**
 * The database's asset list for one problem — filename + size only, never the base64 `data`
 * column, since this backs the picker's list view where pulling every file's bytes on every open
 * would be wasteful. This is the fix for the picker "glitch": listing used to come from
 * fs.readdirSync() on local disk (problem-ops.ts's listProblemAssets), which only reflects
 * whatever images have been fetched into the working copy so far. The database is the
 * durable source of truth (see saveAssetInStorage/deleteAssetInStorage), so the
 * list shown to the author needs to come from here too, the same way ensureAssetLocal already
 * treats the database as authoritative for a single file's bytes.
 */
export async function listAssetsInStorage(folder: string): Promise<Array<{ filename: string; size: number }>> {
  if (!isDbConfigured()) return [];
  await ensureSchema();
  return (await sql()`
    SELECT filename, size FROM problem_assets WHERE folder = ${folder}
  `) as unknown as Array<{ filename: string; size: number }>;
}

/**
 * Makes sure every asset for a problem is present on local disk, fetching any missing ones from
 * the database first. Unlike ensureAssetLocal (one file, fetched lazily as a browser request for
 * it comes in), this is for bulk local-disk readers — ZIP export builds its archive straight off
 * the assets/ folder via adm-zip's addLocalFolder, which would otherwise silently ship whatever a
 * freshly started container's working copy happens to hold instead of the complete set.
 */
export async function ensureAllAssetsLocal(folder: string): Promise<void> {
  if (!isDbConfigured()) return;
  const assets = await listAssetsInStorage(folder);
  await Promise.all(assets.map((asset) => ensureAssetLocal(folder, `assets/${asset.filename}`)));
}

// ---------- mutations ----------

/**
 * Creates a problem. When a database is configured, uniqueness and the MAX_PROBLEMS cap are
 * enforced by the database in one atomic statement: `pg_advisory_xact_lock` inside a CTE
 * serializes concurrent creates for the duration of the statement (the lock is transaction-scoped
 * and this is one implicit transaction), so the count check and the insert can never race each
 * other the way a check-then-insert in application code could. A real UNIQUE constraint is
 * still the backstop for the name itself.
 */
export async function createProblemInStorage(rawName: string): Promise<CreatedProblem> {
  if (!isDbConfigured()) return createProblemLocal(rawName);

  const { folder, content } = buildBlankProblemYaml(rawName);
  await ensureSchema();

  let rows: Array<{ version: number }>;
  try {
    rows = (await sql()`
      WITH lock AS (SELECT pg_advisory_xact_lock(hashtext('problems:create'))),
           cnt  AS (SELECT count(*)::int AS n FROM problems)
      INSERT INTO problems (folder, yaml)
      SELECT ${folder}, ${content} FROM cnt, lock WHERE cnt.n < ${MAX_PROBLEMS}
      RETURNING version
    `) as unknown as Array<{ version: number }>;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new StorageConflictError(`A problem named "${folder}" already exists`);
    }
    throw err;
  }

  if (rows.length === 0) {
    // The statement ran but inserted nothing: the WHERE cnt.n < MAX_PROBLEMS guard blocked it
    // (the folder-name case is normally caught as a unique_violation above instead). Re-check so
    // the message reflects what actually happened rather than assuming.
    const n = await countProblems();
    if (n >= MAX_PROBLEMS) {
      throw new ProblemError(`The maximum number of problems is ${MAX_PROBLEMS}`, {
        hint: `There are currently ${n} problems. To create a new one, please delete a problem you no longer need first.`,
      });
    }
    throw new StorageConflictError(`A problem named "${folder}" already exists`);
  }

  const created = materializeProblemFiles(folder, content);
  localVersions.set(folder, firstRow(rows).version);
  knownFolders?.add(folder);
  return created;
}

export interface SaveYamlResult {
  version: string;
  overwrote: boolean;
}

/**
 * Saves problem.yaml. One `UPDATE … RETURNING version` — the returned version both is the new
 * state and tells us whether this save just overwrote a newer one (returned version minus one,
 * compared against what the client last loaded). Last-write-wins by design: the write always
 * goes through, this only decides what to report.
 */
export async function saveProblemYamlInStorage(
  folder: string,
  content: string,
  baseVersion: string | undefined,
): Promise<SaveYamlResult> {
  if (!isDbConfigured()) {
    const dir = path.join(PROBLEMS_DIR, folder);
    if (!fs.existsSync(dir)) {
      throw new ProblemError('Problem not found', {
        hint: 'This problem may have already been deleted — go back to the main page and pick another one',
      });
    }
    const file = yamlPath(folder);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const overwrote = baseVersion !== undefined && baseVersion !== contentVersion(current);
    writeFileAtomic(file, content);
    return { version: contentVersion(content), overwrote };
  }

  await ensureSchema();
  const rows = (await sql()`
    UPDATE problems SET yaml = ${content}, version = version + 1, updated_at = now()
    WHERE folder = ${folder}
    RETURNING version
  `) as unknown as Array<{ version: number }>;

  if (rows.length === 0) {
    throw new ProblemError('Problem not found', {
      hint: 'This problem may have already been deleted — go back to the main page and pick another one',
    });
  }

  const newVersion = firstRow(rows).version;
  const baseVersionNum = baseVersion !== undefined ? Number(baseVersion) : undefined;
  const overwrote = baseVersionNum !== undefined && !Number.isNaN(baseVersionNum) && baseVersionNum !== newVersion - 1;
  materializeProblem(folder, content, newVersion);
  return { version: String(newVersion), overwrote };
}

/** Deletes a problem and (via ON DELETE CASCADE) its assets. Survives on every instance immediately. */
export async function deleteProblemInStorage(folder: string): Promise<void> {
  if (!isDbConfigured()) {
    const dir = path.join(PROBLEMS_DIR, folder);
    if (!fs.existsSync(dir)) {
      throw new ProblemError('Problem not found', {
        hint: 'This problem may have already been deleted — go back to the main page and pick another one',
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }

  await ensureSchema();
  const rows = (await sql()`DELETE FROM problems WHERE folder = ${folder} RETURNING folder`) as unknown as Array<{
    folder: string;
  }>;
  if (rows.length === 0) {
    throw new ProblemError('Problem not found', {
      hint: 'This problem may have already been deleted — go back to the main page and pick another one',
    });
  }
  knownFolders?.delete(folder);
  removeLocalProblem(folder);
}

/**
 * Saves one image. Local disk write is the caller's responsibility (problem-ops.ts's
 * saveProblemAsset); this only pushes it to the database.
 *
 * Retries transient failures. This matters more here than for other writes: the caller has
 * already written the image to the local working copy before calling this, and that working copy
 * is disposable (see PROBLEMS_DIR_DISPOSABLE) — it does not survive a container restart. If the
 * database push were left to fail outright, the upload would still look successful right now (the
 * local file is right there) while the image was never durably saved, only to 404 after the next
 * restart. See saveProblemAsset.
 */
export async function saveAssetInStorage(folder: string, filename: string, data: Buffer): Promise<void> {
  if (!isDbConfigured()) return;
  await ensureSchema();
  const contentType = contentTypeFor(filename);
  const base64 = data.toString('base64');

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      await sql()`
        INSERT INTO problem_assets (folder, filename, data, content_type, size)
        VALUES (${folder}, ${filename}, ${base64}, ${contentType}, ${data.length})
        ON CONFLICT (folder, filename) DO UPDATE
        SET data = EXCLUDED.data, content_type = EXCLUDED.content_type, size = EXCLUDED.size, updated_at = now()
      `;
      // Keep render.ts's filename check from warning about the image that was just uploaded, in
      // the window before the next reconcile refreshes this view.
      rememberAsset(folder, filename);
      return;
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new ProblemError('Problem not found', {
          hint: 'This problem may have been deleted elsewhere — go back to the main page and pick another one',
        });
      }
      // A unique-constraint hit here would mean a real conflict, not a transient blip — not
      // something a retry fixes, so only unrecognized (likely network/timeout) errors are retried.
      if (isUniqueViolation(err) || attempt === MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

/**
 * Deletes one image from the database. Returns whether a row was actually removed — the caller
 * needs that to answer "did this image exist?", because local disk cannot: the working copy is
 * scratch space, so an image can be absent from local disk and still be perfectly present here.
 */
export async function deleteAssetInStorage(folder: string, filename: string): Promise<boolean> {
  if (!isDbConfigured()) return false;
  await ensureSchema();
  const rows = (await sql()`
    DELETE FROM problem_assets WHERE folder = ${folder} AND filename = ${filename} RETURNING filename
  `) as unknown as Array<{ filename: string }>;
  // Drop it from the synchronous view too, so a yaml file still referencing this image correctly
  // warns again straight away rather than staying quiet until the next reconcile.
  forgetAsset(folder, filename);
  return rows.length > 0;
}

interface ParsedZipProblem {
  folder: string;
  yaml: string;
  assets: Array<{ filename: string; data: Buffer }>;
}

/**
 * Persists a whole parsed ZIP import (studio-server.ts does the archive parsing and name-collision
 * handling, unchanged from before — this only decides where the result is written). Local-only
 * mode writes files directly; database mode enforces the MAX_PROBLEMS cap against the database's
 * real count and pushes every problem plus its assets in one atomic transaction.
 */
export async function importParsedProblems(problems: ParsedZipProblem[], mode: 'add' | 'overwrite'): Promise<void> {
  // Shared by both branches: in 'overwrite' mode the old folder is wiped before rewriting, so an
  // asset present in the old version but absent from the new ZIP does not linger on local disk
  // after the database's own copy of it was already dropped by the CASCADE delete below.
  const materializeAll = (): void => {
    for (const p of problems) {
      if (mode === 'overwrite') {
        try {
          fs.rmSync(path.join(PROBLEMS_DIR, p.folder), { recursive: true, force: true });
        } catch {
          /* nothing there yet */
        }
      }
      materializeProblemFiles(p.folder, p.yaml);
      for (const a of p.assets) writeFileAtomic(assetPath(p.folder, a.filename), a.data);
    }
  };

  if (!isDbConfigured()) {
    materializeAll();
    return;
  }

  await ensureSchema();

  if (mode === 'overwrite') {
    for (const p of problems) {
      await sql()`DELETE FROM problems WHERE folder = ${p.folder}`;
    }
  }

  const existingCount = await countProblems();
  if (existingCount + problems.length > MAX_PROBLEMS) {
    throw new ProblemError(
      `Cannot import — this would put the total number of problems over the maximum of ${MAX_PROBLEMS} (currently ${existingCount}, adding ${problems.length})`,
      { hint: `A maximum of ${MAX_PROBLEMS} problems is allowed. Please delete some problems you don't need before importing.` },
    );
  }

  const queries: Array<PendingQuery<unknown>> = [];
  const sqlFn = sql();
  for (const p of problems) {
    queries.push(
      sqlFn`
        INSERT INTO problems (folder, yaml) VALUES (${p.folder}, ${p.yaml})
        ON CONFLICT (folder) DO UPDATE SET yaml = EXCLUDED.yaml, version = problems.version + 1, updated_at = now()
      `,
    );
    for (const a of p.assets) {
      const contentType = contentTypeFor(a.filename);
      queries.push(
        sqlFn`
          INSERT INTO problem_assets (folder, filename, data, content_type, size)
          VALUES (${p.folder}, ${a.filename}, ${a.data.toString('base64')}, ${contentType}, ${a.data.length})
          ON CONFLICT (folder, filename) DO UPDATE
          SET data = EXCLUDED.data, content_type = EXCLUDED.content_type, size = EXCLUDED.size, updated_at = now()
        `,
      );
    }
  }
  if (queries.length > 0) {
    await sqlFn.transaction(queries);
  }

  materializeAll();
  for (const p of problems) {
    knownFolders?.add(p.folder);
  }
}

// ---------- cold start ----------

/**
 * Prepares PROBLEMS_DIR for this instance. First run ever against this database: adopt whatever is
 * already on local disk (the problems committed to the repository, if any) and push it up, so the
 * project is not empty on first use. Every run after that: the
 * database wins, and the working copy is reconciled to match it — including a database a user has
 * since emptied by deleting every problem, which must stay empty rather than being silently
 * repopulated from an instance's local checkout.
 *
 * "First run ever" is tracked by an explicit storage_meta row, atomically claimed with
 * `ON CONFLICT DO NOTHING`, not by `countProblems() === 0` — row count can't distinguish "never
 * seeded" from "seeded once, now empty because the user deleted everything," and the count-based
 * check used to reseed the latter case on every cold start that landed on an empty table.
 */
export async function initStorage(): Promise<void> {
  if (!isDbConfigured()) return;

  const startedAt = Date.now();
  try {
    await ensureSchema();
    const claimed = (await sql()`
      INSERT INTO storage_meta (key, value) VALUES ('seeded', 'true')
      ON CONFLICT (key) DO NOTHING
      RETURNING key
    `) as unknown as Array<{ key: string }>;

    if (claimed.length > 0) {
      // Won the race to seed a brand-new database. Still guard on count too, in case this is the
      // first deploy of the storage_meta table itself against a database that already has real
      // problems in it — the marker row would not exist yet either way, but there is nothing to
      // seed in that case.
      const n = await countProblems();
      if (n === 0) {
        const dirs = listProblemDirs();
        for (const dir of dirs) {
          const folder = path.basename(dir);
          try {
            const yaml = fs.readFileSync(path.join(dir, 'problem.yaml'), 'utf8');
            await sql()`INSERT INTO problems (folder, yaml) VALUES (${folder}, ${yaml}) ON CONFLICT (folder) DO NOTHING`;
            const assetsDir = path.join(dir, 'assets');
            if (fs.existsSync(assetsDir)) {
              for (const filename of fs.readdirSync(assetsDir)) {
                if (filename === '.gitkeep') continue;
                const data = fs.readFileSync(path.join(assetsDir, filename));
                await sql()`
                  INSERT INTO problem_assets (folder, filename, data, content_type, size)
                  VALUES (${folder}, ${filename}, ${data.toString('base64')}, ${contentTypeFor(filename)}, ${data.length})
                  ON CONFLICT (folder, filename) DO NOTHING
                `;
              }
            }
          } catch (err) {
            console.error(`[Storage] Could not seed "${folder}" into the database:`, err);
          }
        }
        console.log(`[Storage] Seeded the database with ${dirs.length} problem(s) from the local checkout`);
      }
    }

    await reconcile();
    lastSyncError = undefined;
    lastFullSync = Date.now();
    console.log(`[Storage] Working copy in sync with the database (${Date.now() - startedAt}ms, ${knownFolders?.size ?? 0} problems)`);
  } catch (err) {
    lastSyncError = err instanceof Error ? err.message : String(err);
    console.error('[Storage Error] Initial sync with the database failed:', err);
  }
}
