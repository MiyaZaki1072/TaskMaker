/**
 * PDF export: one problem, every problem, or all of them combined into one booklet. The rendering
 * itself is in src/pdf-export.ts and src/booklet.ts; this file only wires it to HTTP.
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { type RequestHandler, type Router } from 'express';
import { buildBooklet, type BookletOptions } from '../booklet.js';
import { ProblemError } from '../errors.js';
import { exportProblemPdf, mapConcurrent, PDF_CONCURRENCY } from '../pdf-export.js';
import { DIST_DIR, listProblemDirs, loadProblem } from '../render.js';
import { getBrowser, handle, paramStr, resolveFolderPresent } from './shared.js';

function pdfDownloadUrl(folder: string): string {
  return `/api/problems/${encodeURIComponent(folder)}/pdf/file`;
}

/** `heavyLimiter` is shared with the other expensive routes, so they count against one budget */
export function pdfRoutes(heavyLimiter: RequestHandler): Router {
  const router = express.Router();

  router.post('/problems/:folder/pdf', heavyLimiter, handle(async (req, res) => {
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

  router.get('/problems/:folder/pdf/file', handle(async (req, res) => {
    const dir = await resolveFolderPresent(paramStr(req.params.folder));
    const problem = loadProblem(dir);
    const file = path.join(DIST_DIR, `${problem.task.code}.pdf`);
    if (!fs.existsSync(file)) {
      throw new ProblemError('No PDF file has been generated for this problem yet', {
        hint: 'Click "Export PDF" first, then download it',
      });
    }
    // Relative to `root` for the same reason as the /problem-assets route: DIST_DIR sits under
    // /app/.runtime in the container, and `send` 404s any absolute path through a dot-directory.
    res.download(path.basename(file), `${problem.task.code}.pdf`, { root: DIST_DIR });
  }));

  router.post('/export-all', heavyLimiter, handle(async (_req, res) => {
    const dirs = listProblemDirs();
    const browser = await getBrowser();
    type ExportAllResult = { folder: string; ok: boolean; code?: string; downloadUrl?: string; errorMessage?: string };

    const results = await mapConcurrent(dirs, PDF_CONCURRENCY, async (dir): Promise<ExportAllResult> => {
      const folder = path.basename(dir);
      try {
        const result = await exportProblemPdf(dir, browser);
        return { folder, ok: true, code: result.code, downloadUrl: pdfDownloadUrl(folder) };
      } catch (err) {
        const message =
          err instanceof ProblemError ? err.message : err instanceof Error ? err.message : String(err);
        return { folder, ok: false, errorMessage: message };
      }
    });

    res.json({ results });
  }));

  router.post('/booklet', heavyLimiter, handle(async (req, res) => {
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
    const options: BookletOptions = {};
    if (typeof body.contestName === 'string' && body.contestName.trim()) options.contestName = body.contestName.trim();
    if (typeof body.logo === 'string' && body.logo.trim()) options.logo = body.logo.trim();
    if (typeof body.authors === 'string' && body.authors.trim()) options.authors = body.authors.trim();
    if (typeof body.rules === 'string' && body.rules.trim()) options.rules = body.rules.trim();

    const result = await buildBooklet(dirs, browser, undefined, Object.keys(options).length > 0 ? options : undefined);
    res.json({ ok: true, pageCount: result.pageCount, parts: result.parts, downloadUrl: '/api/booklet/file' });
  }));

  router.get('/booklet/file', handle((_req, res) => {
    const file = path.join(DIST_DIR, 'booklet.pdf');
    if (!fs.existsSync(file)) {
      throw new ProblemError('No combined booklet file has been generated yet', { hint: 'Click "Combine into one booklet" first, then download it' });
    }
    res.download('booklet.pdf', 'booklet.pdf', { root: DIST_DIR });
  }));

  return router;
}
