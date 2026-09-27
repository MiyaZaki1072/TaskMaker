/**
 * Helpers shared by every route file in this folder: reading URL parameters safely, resolving a
 * problem folder, turning errors into JSON, accepting image uploads, and the shared Chromium.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { type Browser } from 'puppeteer';
import { ProblemError } from '../errors.js';
import { launchBrowser } from '../pdf-export.js';
import { PROBLEMS_DIR } from '../render.js';
import { ensureProblemPresent, StorageConflictError } from '../storage-db.js';

const FOLDER_RE = /^[^\\/]+$/;

/** Express 5 (path-to-regexp v8) always types req.params as string | string[] | undefined */
export function paramStr(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Resolves a problem folder from a URL parameter, guarding against names containing / or .. that would escape problems/ */
export function resolveFolder(folderParam: string): string {
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
export async function resolveFolderPresent(folderParam: string): Promise<string> {
  await ensureProblemPresent(folderParam);
  return resolveFolder(folderParam);
}

export function sendError(res: Response, err: unknown): void {
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
export function handle(fn: Handler) {
  return (req: Request, res: Response) => {
    Promise.resolve(fn(req, res)).catch((err) => sendError(res, err));
  };
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

/** Takes one image from the `file` field, answering a too-big or malformed upload with a readable error */
export function acceptImageUpload(req: Request, res: Response, next: NextFunction): void {
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
}

// Launch Chromium lazily (on first export) and reuse the same instance afterwards
let browserPromise: Promise<Browser> | undefined;

export function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launchBrowser().catch((err: unknown) => {
      browserPromise = undefined;
      throw err;
    });
  }
  return browserPromise;
}

/** Closes the shared Chromium, if one was ever launched — called when the studio shuts down */
export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => undefined);
    await browser?.close().catch(() => undefined);
  }
}
