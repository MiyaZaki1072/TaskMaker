/**
 * ZIP export and import: one problem, or the whole studio (every problem plus the library) as a
 * backup, and importing either back — as new problems, or overwriting ones with the same name.
 */
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import express, { type NextFunction, type Request, type RequestHandler, type Response, type Router } from 'express';
import multer from 'multer';
import { ProblemError } from '../errors.js';
import {
  addLibraryToZip,
  flattenGlobalRefs,
  importLibrary,
  isZipLibraryEmpty,
  readLibraryFromZip,
} from '../library.js';
import { listProblemAssets } from '../problem-ops.js';
import { listProblemDirs } from '../render.js';
import {
  ensureAllAssetsLocal,
  importParsedProblems,
  isDbConfigured,
  listKnownFolders,
  syncFromStorage,
} from '../storage-db.js';
import { handle, paramStr, resolveFolderPresent, sendError } from './shared.js';

interface ParsedZipProblem {
  folder: string;
  yaml: string;
  assets: Array<{ filename: string; data: Buffer }>;
}

/**
 * Parses a ZIP into problem records in memory — no filesystem writes here. This lets the
 * database (when configured) decide what actually gets kept — the atomic multi-row write —
 * before anything touches local disk; importParsedProblems in
 * storage-db.ts does that decision and the eventual materialization.
 */
function parseProblemsZip(zip: AdmZip, mode: 'add' | 'overwrite', existingFolders: Set<string>): ParsedZipProblem[] {
  const entries = zip.getEntries();

  // Zip bomb protection: reject if the total decompressed size exceeds 100MB. Checked before
  // anything is decompressed — including the library, which the caller reads after this.
  let totalDecompressedSize = 0;
  const MAX_ZIP_DECOMPRESSED = 100 * 1024 * 1024; // 100MB
  for (const entry of entries) {
    totalDecompressedSize += entry.header.size;
    if (totalDecompressedSize > MAX_ZIP_DECOMPRESSED) {
      throw new ProblemError('The ZIP file exceeds the safety limit for decompressed size (100MB)');
    }
  }

  // None is fine here: an Export All from a studio with no problems carries only its library.
  // The caller reports a ZIP with neither.
  const yamlEntries = entries.filter((e) => !e.isDirectory && /(?:^|[\\/])problem\.yaml$/i.test(e.entryName));

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

/**
 * Adds one problem to an export ZIP under `folderName/`. With `flatten`, live `global/…`
 * references are turned into ordinary images inside the problem's own assets/ (see
 * flattenGlobalRefs), so the package is complete wherever it is imported. Without it they stay
 * live, for Export All, which carries the library alongside. The studio's copy is not touched.
 */
async function addProblemToZip(zip: AdmZip, dir: string, folderName: string, flatten: boolean): Promise<void> {
  // addLocalFolder reads straight off local disk, and images are only fetched into the working
  // copy when something asks for them — hydrate first so the ZIP is never a silent partial
  // backup (see ensureAllAssetsLocal).
  await ensureAllAssetsLocal(folderName);
  if (!flatten) {
    zip.addLocalFolder(dir, folderName);
    return;
  }
  const yaml = fs.readFileSync(path.join(dir, 'problem.yaml'), 'utf8');
  const localAssets = listProblemAssets(dir).map((asset) => asset.name);
  const flattened = await flattenGlobalRefs(yaml, localAssets);
  if (flattened.files.length === 0) {
    zip.addLocalFolder(dir, folderName);
    return;
  }
  // adm-zip hands the filter the zip-side path joined with the OS separator ("Task\problem.yaml"
  // on Windows), so compare it normalized
  const originalYaml = `${folderName}/problem.yaml`;
  zip.addLocalFolder(dir, folderName, (entryPath: string) => entryPath.split(/[\\/]/).join('/') !== originalYaml);
  zip.addFile(`${folderName}/problem.yaml`, Buffer.from(flattened.yaml, 'utf8'));
  for (const file of flattened.files) {
    zip.addFile(`${folderName}/assets/${file.filename}`, file.data);
  }
}

const uploadZip = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

/** `heavyLimiter` is shared with the other expensive routes, so they count against one budget */
export function zipRoutes(heavyLimiter: RequestHandler): Router {
  const router = express.Router();

  // Export every problem as a single ZIP file — the studio's backup, so the library comes too
  router.get('/export-zip', handle(async (_req, res) => {
    const dirs = listProblemDirs();
    const zip = new AdmZip();
    for (const dir of dirs) {
      await addProblemToZip(zip, dir, path.basename(dir), false);
    }
    const library = await addLibraryToZip(zip);
    if (dirs.length === 0 && library.images === 0 && library.snippets === 0) {
      throw new ProblemError('There are no problems in the system, so a ZIP cannot be created');
    }
    const buffer = zip.toBuffer();
    const dateStr = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="problems-package-${dateStr}.zip"`);
    res.send(buffer);
  }));

  // Export a single problem as a ZIP
  router.get('/problems/:folder/export-zip', handle(async (req, res) => {
    const dir = await resolveFolderPresent(paramStr(req.params.folder));
    const folderName = path.basename(dir);
    const zip = new AdmZip();
    await addProblemToZip(zip, dir, folderName, true);
    const buffer = zip.toBuffer();
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${folderName}.zip"`);
    res.send(buffer);
  }));

  // Import problems from a ZIP file
  router.post(
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
      let zip: AdmZip;
      try {
        zip = new AdmZip(file.buffer);
      } catch (err) {
        throw new ProblemError('The file could not be read as a ZIP', {
          details: [err instanceof Error ? err.message : String(err)],
        });
      }
      const parsed = parseProblemsZip(zip, mode, existing);
      const zipLibrary = readLibraryFromZip(zip);
      if (parsed.length === 0 && isZipLibraryEmpty(zipLibrary)) {
        throw new ProblemError('No problem.yaml file found in the uploaded ZIP', {
          hint: 'Please check that the selected ZIP is a valid problem package',
        });
      }

      // Problems first: that write is all-or-nothing, and a failure there should not leave the
      // library half imported from a package that was rejected
      if (parsed.length > 0) await importParsedProblems(parsed, mode);
      const library = await importLibrary(zipLibrary, mode);
      const imported = parsed.map((p) => p.folder);
      res.json({ ok: true, count: imported.length, imported, mode, library });
    }),
  );

  return router;
}
