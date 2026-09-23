/**
 * Problem operations shared by both the CLI (scripts/*.ts) and the Studio web app (src/studio-server.ts)
 * Written once here to avoid divergent behavior between the two (e.g. folder naming rules or error messages)
 */
import fs from 'node:fs';
import path from 'node:path';
import { ProblemError } from './errors.js';
import { writeFileAtomic } from './fs-atomic.js';
import { BLANK_TEMPLATE_FILE, listProblemDirs, PROBLEMS_DIR, renderProblem, toDisplayPath } from './render.js';

/** Strips characters that are illegal in folder names on Windows/macOS/Linux */
export function toFolderName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_');
  if (!cleaned) {
    throw new ProblemError('That problem name cannot be used as a folder name', {
      hint: 'Try letters, numbers, underscores, or hyphens, e.g. "PrePosn2_Graph"',
    });
  }
  return cleaned;
}

export interface CreatedProblem {
  dir: string;
  folder: string;
  relative: string;
}

/**
 * Fills the blank template in for one new problem. Pure — no filesystem writes — so a
 * database-backed create can build the content, let the database decide whether the name is
 * free and the problem count has room, and only then materialize files on a successful insert.
 */
export function buildBlankProblemYaml(rawName: string): { folder: string; content: string } {
  const trimmed = rawName.trim();
  if (!trimmed) {
    throw new ProblemError('No name was given for the new problem', {
      hint: 'Enter a problem name first, e.g. "PrePosn2_Tree"',
    });
  }
  const folder = toFolderName(trimmed);
  const template = fs.readFileSync(BLANK_TEMPLATE_FILE, 'utf8');
  const content = template.replace('__CODE__', folder).replace('__NAME__', trimmed);
  return { folder, content };
}

/** Writes a problem's files to disk. The disk-writing half of createProblem, reusable after a database insert has already decided the folder is free. */
export function materializeProblemFiles(folder: string, content: string): CreatedProblem {
  const dir = path.join(PROBLEMS_DIR, folder);
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  writeFileAtomic(path.join(dir, 'problem.yaml'), content);
  // .gitkeep so the assets/ folder is tracked by git even before any image is added
  writeFileAtomic(path.join(dir, 'assets', '.gitkeep'), '');
  return { dir, folder, relative: toDisplayPath(dir) };
}

/**
 * Creates a new problem folder from the template on the local filesystem, returns where it was
 * created. This is the whole story when there is no database configured (plain local files, no
 * cross-instance concerns); when a database is configured, storage-db.ts's createProblemInStorage
 * uses buildBlankProblemYaml + materializeProblemFiles instead, so the database — not a
 * filesystem existence check — decides uniqueness.
 */
export function createProblem(rawName: string): CreatedProblem {
  const { folder, content } = buildBlankProblemYaml(rawName);

  const dir = path.join(PROBLEMS_DIR, folder);
  if (fs.existsSync(dir)) {
    throw new ProblemError(`A problem named "${folder}" already exists`, {
      details: [`The conflicting folder is ${toDisplayPath(dir)}`],
      hint: 'Choose a different name, or open the existing problem if you meant to edit it',
    });
  }

  return materializeProblemFiles(folder, content);
}

export interface CheckError {
  message: string;
  details: string[];
  hint?: string;
  file?: string;
}

export interface ProblemCheck {
  dir: string;
  folder: string;
  label: string;
  ok: boolean;
  code?: string;
  name?: string;
  warnings: string[];
  error?: CheckError;
}

/** Validates one problem (uses the real renderProblem so both schema issues and render issues, like a missing image, surface) */
export function checkProblem(dir: string): ProblemCheck {
  const folder = path.basename(dir);
  const label = toDisplayPath(dir);
  try {
    const { problem, warnings } = renderProblem(dir, { live: false, showWarnings: false });
    return { dir, folder, label, ok: true, code: problem.task.code, name: problem.task.name, warnings };
  } catch (err) {
    const friendly =
      err instanceof ProblemError
        ? err
        : new ProblemError('An unexpected error occurred', {
            details: [err instanceof Error ? err.message : String(err)],
          });
    return {
      dir,
      folder,
      label,
      ok: false,
      warnings: [],
      error: { message: friendly.message, details: friendly.details, hint: friendly.hint, file: friendly.file },
    };
  }
}

export interface AssetInfo {
  name: string;
  size: number;
  url: string;
}

const ASSET_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,118})$/;
const ALLOWED_ASSET_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);

/** Rejects malformed filenames (path traversal, non-image extensions) before writing to disk */
export function sanitizeAssetName(rawName: string): string {
  const base = path.basename(rawName).trim();
  const ext = path.extname(base).toLowerCase();
  if (!ASSET_NAME_RE.test(base) || !ALLOWED_ASSET_EXT.has(ext)) {
    throw new ProblemError(`The filename "${rawName}" cannot be used`, {
      hint: 'Use only letters, numbers, dots, hyphens, or underscores, and it must be an image file (.png .jpg .jpeg .gif .svg .webp)',
    });
  }
  return base;
}

function assetUrl(folder: string, filename: string): string {
  return `/problem-assets/${encodeURIComponent(folder)}/${encodeURIComponent(filename)}`;
}

/** Builds the same {name, size, url} shape listProblemAssets/saveProblemAsset return, for callers building the list from another source (e.g. the database) */
export function assetInfo(folder: string, filename: string, size: number): AssetInfo {
  return { name: filename, size, url: assetUrl(folder, filename) };
}

/** Lists every image file in the problem's assets/ folder */
export function listProblemAssets(dir: string): AssetInfo[] {
  const assetsDir = path.join(dir, 'assets');
  if (!fs.existsSync(assetsDir)) return [];
  const folder = path.basename(dir);
  return fs
    .readdirSync(assetsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== '.gitkeep')
    .map((entry) => {
      const stat = fs.statSync(path.join(assetsDir, entry.name));
      return { name: entry.name, size: stat.size, url: assetUrl(folder, entry.name) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'th'));
}

/** Strips dangerous content from SVG (e.g. <script>, onclick, onload, javascript:) to prevent stored XSS */
export function sanitizeSvg(data: Buffer): Buffer {
  let xml = data.toString('utf8');
  // Strip <script>...</script> in every form
  xml = xml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  // Strip event handlers such as onload=, onerror=, onclick=, onmouseover=
  xml = xml.replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // Strip href/xlink:href that start with javascript: or data:text/html
  xml = xml.replace(/(?:href|xlink:href)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'href=""');
  xml = xml.replace(/(?:href|xlink:href)\s*=\s*(?:"data:text\/html[^"]*"|'data:text\/html[^']*')/gi, 'href=""');
  return Buffer.from(xml, 'utf8');
}

/** Saves an uploaded image into the problem's assets/ folder */
export function saveProblemAsset(dir: string, filename: string, data: Buffer): AssetInfo {
  const safe = sanitizeAssetName(filename);
  const ext = path.extname(safe).toLowerCase();
  const fileData = ext === '.svg' ? sanitizeSvg(data) : data;
  const assetsDir = path.join(dir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  writeFileAtomic(path.join(assetsDir, safe), fileData);
  const stat = fs.statSync(path.join(assetsDir, safe));
  return { name: safe, size: stat.size, url: assetUrl(path.basename(dir), safe) };
}

/**
 * Deletes an image from the problem's assets/ folder. Returns whether a local file was actually
 * removed.
 *
 * A missing local file is deliberately not an error. The working copy is scratch space in the
 * container, so an image uploaded before the last restart legitimately exists only in the
 * database until something asks for it. Throwing here meant the caller never reached
 * deleteAssetInStorage, so "delete this image" failed with a bogus "not found in this problem" and
 * left the database row behind. Whether the image existed at all is the database's answer to give
 * (see the DELETE route in studio-server.ts), not local disk's.
 */
export function deleteProblemAsset(dir: string, filename: string): boolean {
  const safe = sanitizeAssetName(filename);
  const full = path.join(dir, 'assets', safe);
  if (!fs.existsSync(full)) return false;
  fs.unlinkSync(full);
  return true;
}

/** Deletes a problem folder and everything inside it */
export function deleteProblem(dir: string): void {
  if (!fs.existsSync(dir)) {
    throw new ProblemError('Problem not found', {
      hint: 'This problem may have already been deleted — go back to the main page and pick another one',
    });
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
