/**
 * /api/problems — list, create, delete, read and save a problem's YAML, and manage its images.
 * Export (PDF, ZIP) lives in routes/pdf.ts and routes/zip.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { ProblemError } from '../errors.js';
import {
  assetInfo,
  checkProblem,
  deleteProblemAsset,
  listProblemAssets,
  sanitizeAssetName,
  saveProblemAsset,
  type ProblemCheck,
} from '../problem-ops.js';
import { listProblemDirs } from '../render.js';
import {
  createProblemInStorage,
  currentVersion,
  deleteAssetInStorage,
  deleteProblemInStorage,
  ensureProblemCurrent,
  isDbConfigured,
  listAssetsInStorage,
  listKnownFolders,
  saveAssetInStorage,
  saveProblemYamlInStorage,
  storageHealth,
  syncFromStorage,
} from '../storage-db.js';
import { acceptImageUpload, handle, paramStr, resolveFolder, resolveFolderPresent } from './shared.js';

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

export function problemRoutes(): Router {
  const router = express.Router();

  router.get('/problems', handle(async (_req, res) => {
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
    res.json({ problems, count: problems.length, warning });
  }));

  router.post('/problems', handle(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    // The database enforces name uniqueness with a real UNIQUE constraint (see
    // createProblemInStorage), so no in-process lock is needed here.
    const created = await createProblemInStorage(name);
    res.status(201).json({ folder: created.folder });
  }));

  router.get('/problems/:folder/yaml', handle(async (req, res) => {
    const folderParam = paramStr(req.params.folder);
    await ensureProblemCurrent(folderParam);
    const dir = resolveFolder(folderParam);
    const content = fs.readFileSync(path.join(dir, 'problem.yaml'), 'utf8');
    // version travels back on save so the server can tell whether this editor was looking at
    // the current file or at one somebody else has since changed
    res.json({ content, version: currentVersion(folderParam, content) });
  }));

  router.put('/problems/:folder/yaml', handle(async (req, res) => {
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

  router.delete('/problems/:folder', handle(async (req, res) => {
    const folder = paramStr(req.params.folder);
    await deleteProblemInStorage(folder);
    res.json({ ok: true, folder });
  }));

  router.get('/problems/:folder/assets', handle(async (req, res) => {
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

  router.post(
    '/problems/:folder/assets',
    acceptImageUpload,
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

  router.delete('/problems/:folder/assets/:filename', handle(async (req, res) => {
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

  return router;
}
