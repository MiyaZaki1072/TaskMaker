/**
 * The heart of the system: read problem.yaml → validate → build HTML
 *
 * Both live preview and PDF export use the same functions in this file,
 * so what you see on screen always matches what you get in the PDF.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Handlebars from 'handlebars';
import YAML from 'yaml';
import { problemSchema, formatZodIssues, type Problem } from '../config/schema.js';
import { ProblemError } from './errors.js';
import { createContext, escapeHtml, renderInline, renderRich, type RenderContext } from './text.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Cache policy for files whose bytes never change for a given URL: the vendored fonts, and the
 * KaTeX / highlight.js files served straight out of node_modules.
 *
 * express.static sends no Cache-Control at all by default, so a browser revalidates every one of
 * these on every single page load. `immutable` matters as much as the long max-age here: it stops
 * the revalidation on a plain reload too, not just the download.
 *
 * Deliberately NOT applied to studio.css, the studio scripts or assets/style.css: those change
 * whenever the app is redeployed. They are served `private, no-cache` (ETag revalidation, a cheap
 * 304) and the studio pages add a content hash to their URLs — the header alone is not enough
 * behind Cloudflare, which rewrites it to hours (see ASSET_VERSION in studio-pages.ts).
 */
export const IMMUTABLE_ASSET = { maxAge: '365d', immutable: true } as const;

/** The repo's own problems/ folder — real, committed work that must never be auto-deleted */
const REPO_PROBLEMS_DIR = path.join(ROOT, 'problems');

/**
 * Where the working copy lives.
 *
 *   - local checkout (`npm run studio`): the repo's own problems/ folder, which is your work
 *   - container: whatever PROBLEMS_DIR says, pointed at scratch space inside the container.
 *     Postgres is the durable copy there; see docker-compose.yml.
 */
export const PROBLEMS_DIR = process.env.PROBLEMS_DIR
  ? path.resolve(process.env.PROBLEMS_DIR)
  : REPO_PROBLEMS_DIR;

export const DIST_DIR = process.env.DIST_DIR ? path.resolve(process.env.DIST_DIR) : path.join(ROOT, 'dist');

/**
 * Whether PROBLEMS_DIR is a throwaway working copy that storage-db.ts's reconcile is allowed to
 * delete stale entries from. Opt-in via PROBLEMS_DIR_DISPOSABLE=1, which the container sets and
 * which verification scripts working in a scratch directory can set too.
 *
 * The guard is the point: reconcile deletes any local folder the database does not know about, so
 * pointing this at a real checkout would delete problems that simply have not been pushed up yet.
 * Rather than trust every future caller to set two env vars consistently, the opt-in is refused
 * outright when the working copy *is* the repo's problems/ folder.
 */
function resolveDisposable(): boolean {
  const requested = process.env.PROBLEMS_DIR_DISPOSABLE === '1';
  if (requested && PROBLEMS_DIR === REPO_PROBLEMS_DIR) {
    console.warn(
      `[Storage] Ignoring PROBLEMS_DIR_DISPOSABLE: the working copy is the repository's own problems/ folder, ` +
        'and treating it as disposable would delete problems that are not in the database. ' +
        'Set PROBLEMS_DIR to a scratch directory as well if that is really what you want.',
    );
    return false;
  }
  return requested;
}
export const PROBLEMS_DIR_DISPOSABLE = resolveDisposable();
export const TEMPLATE_FILE = path.join(ROOT, 'templates', 'render.hbs');
export const BLANK_TEMPLATE_FILE = path.join(ROOT, 'templates', 'problem.template.yaml');

let seeded = false;

/**
 * Copy the repo's committed problems into the working copy once, so a deployment whose working
 * copy starts empty (a fresh container) still shows the problems that ship with the checkout,
 * and can create new ones next to them.
 *
 * Only runs when the working copy is somewhere other than the repo's own problems/ folder — with
 * a local checkout there is nothing to copy, the files are already the working copy.
 *
 * Runs exactly once, at module load, and never again: it used to be called from
 * listProblemDirs()/resolveProblemDir() on every request, which meant deleting a seeded problem
 * only lasted until the next request re-copied it out of the repo. The database is the source of
 * truth now (see storage-db.ts), and its reconcile step removes any seed the database does not
 * know about.
 */
export function seedWorkingCopy(): void {
  if (seeded || PROBLEMS_DIR === REPO_PROBLEMS_DIR) return;
  seeded = true;
  const seedProblemsDir = REPO_PROBLEMS_DIR;
  if (!fs.existsSync(seedProblemsDir)) return;
  if (!fs.existsSync(PROBLEMS_DIR)) {
    fs.mkdirSync(PROBLEMS_DIR, { recursive: true });
  }
  try {
    const entries = fs.readdirSync(seedProblemsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const target = path.join(PROBLEMS_DIR, entry.name);
        if (!fs.existsSync(target)) {
          fs.cpSync(path.join(seedProblemsDir, entry.name), target, { recursive: true });
        }
      }
    }
  } catch (err) {
    console.error(`Failed to copy the bundled problems into ${PROBLEMS_DIR}:`, err);
  }
  if (!fs.existsSync(DIST_DIR)) {
    try {
      fs.mkdirSync(DIST_DIR, { recursive: true });
    } catch {}
  }
}

// Runs at module load, before anything asks what problems exist. seedWorkingCopy() is a no-op
// for a local checkout, so this needs no deployment check of its own.
seedWorkingCopy();

let cachedTemplate: { source: string; fn: HandlebarsTemplateDelegate } | undefined;

function getTemplate(): HandlebarsTemplateDelegate {
  const source = fs.readFileSync(TEMPLATE_FILE, 'utf8');
  if (!cachedTemplate || cachedTemplate.source !== source) {
    cachedTemplate = { source, fn: Handlebars.compile(source) };
  }
  return cachedTemplate.fn;
}

/** Resolves a problem directory from whatever the user typed — supports "problems/X", "X", and full paths */
export function resolveProblemDir(input: string): string {
  const candidates = [path.resolve(input), path.resolve(ROOT, input), path.resolve(PROBLEMS_DIR, input)];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'problem.yaml'))) return candidate;
  }
  const available = listProblemDirs()
    .map((dir) => `problems/${path.basename(dir)}`)
    .join(', ');
  throw new ProblemError(`Problem "${input}" not found`, {
    details: [
      'The system looked for a problem.yaml file in the given folder but could not find one',
      available ? `Problems that currently exist: ${available}` : 'There are no problems in the problems/ folder yet',
    ],
    hint: 'Try typing the folder name exactly as it appears under problems/, or create a new problem with  npm run new "problem name"',
  });
}

/** List of all problem directories (sorted alphabetically) */
export function listProblemDirs(): string[] {
  if (!fs.existsSync(PROBLEMS_DIR)) return [];
  return fs
    .readdirSync(PROBLEMS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(PROBLEMS_DIR, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, 'problem.yaml')))
    .sort((a, b) => a.localeCompare(b, 'th'));
}

/** Short display path for showing to the user (always uses / so it reads well on both Windows and macOS) */
export function toDisplayPath(file: string): string {
  const relative = path.relative(ROOT, file) || file;
  return relative.split(path.sep).join('/');
}

/** Reads + validates problem.yaml and returns usable data */
export function loadProblem(problemDir: string): Problem {
  const file = path.join(problemDir, 'problem.yaml');
  const relative = toDisplayPath(file);

  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ProblemError('Could not open problem.yaml', {
      file: relative,
      hint: 'Check that the file is still in the problem folder and has not been renamed',
    });
  }

  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const lineMatch = message.match(/at line (\d+)/);
    throw new ProblemError('problem.yaml is malformed and could not be parsed', {
      file: relative,
      details: [
        lineMatch ? `The problem is around line ${lineMatch[1]}` : 'The system could not pinpoint the exact line',
        'Common causes: missing space after a colon (:), inconsistent indentation, or a tab used instead of spaces',
      ],
      hint:
        'Open the file and check that the indentation (leading spaces) matches the example in templates/problem.template.yaml, ' +
        'and always use the space bar instead of Tab',
    });
  }

  if (data === null || typeof data !== 'object') {
    throw new ProblemError('problem.yaml is empty or has no content', {
      file: relative,
      hint: 'Copy the content from templates/problem.template.yaml and edit it for your problem',
    });
  }

  const result = problemSchema.safeParse(data);
  if (!result.success) {
    throw new ProblemError('The content of problem.yaml is incomplete or invalid', {
      file: relative,
      details: formatZodIssues(result.error),
      hint: 'Compare against the sample file templates/problem.template.yaml to see which section is missing',
    });
  }
  return result.data;
}

/**
 * Whether durable storage may hold this image, for the "is this filename a typo?" check below.
 *
 * Injected by storage-db.ts rather than imported from it: storage-db.ts already imports this
 * module for PROBLEMS_DIR, so importing it back would be a cycle. The default answers "no", which
 * is the right answer whenever storage-db.ts is not in play at all (the plain CLI preview), where
 * local disk really is the whole truth.
 */
type StorageAssetLookup = (folder: string, filename: string) => boolean;
let storageMayHaveAsset: StorageAssetLookup = () => false;

export function setStorageAssetLookup(lookup: StorageAssetLookup): void {
  storageMayHaveAsset = lookup;
}

/** Converts an image path from the yaml file into a URL the browser can load */
function toAssetUrl(raw: string, problemDir: string, ctx: RenderContext, basePath: string): string {
  if (/^(https?:|data:)/i.test(raw)) return raw;
  const cleaned = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^assets\//, '');
  const onDisk = path.join(problemDir, 'assets', cleaned);
  // This warning exists to catch a misspelled filename, so it must only fire when the image is
  // genuinely nowhere. Local disk alone cannot answer that: the working copy is per-instance
  // (scratch space in the container), so an image that is safe in the database is routinely
  // absent from it, and
  // checking only disk turned this into a false alarm that kept coming back on every render path
  // — "the warning keeps appearing even though the image is there". Ask durable storage too.
  if (!fs.existsSync(onDisk) && !storageMayHaveAsset(path.basename(problemDir), cleaned)) {
    ctx.warnings.push(
      `Image file "${raw}" not found — the system looked at ${toDisplayPath(onDisk)} ` +
        'Please check the filename (uppercase/lowercase must match exactly)',
    );
  }
  return `${basePath}/${cleaned.split('/').map(encodeURIComponent).join('/')}`;
}

export interface RenderResult {
  html: string;
  problem: Problem;
  warnings: string[];
}

export interface RenderOptions {
  /** Whether to inject the auto-reload script (only used for preview) */
  live?: boolean;
  /** Whether to show the warnings box on the page (preview = shown, PDF = hidden) */
  showWarnings?: boolean;
  /**
   * Base URL path for files under the problem's assets/ folder (normally "/problem-assets")
   * Used when the Studio web page needs to keep multiple problems separate on a single server,
   * e.g. "/problem-assets/Example_Task"
   */
  assetsBasePath?: string;
}

export function renderProblem(problemDir: string, options: RenderOptions = {}): RenderResult {
  const problem = loadProblem(problemDir);
  const ctx = createContext();
  const assetsBasePath = options.assetsBasePath ?? '/problem-assets';
  ctx.resolveAsset = (raw: string) => toAssetUrl(raw, problemDir, ctx, assetsBasePath);

  const subtasks = problem.subtasks.map((subtask, index) => ({
    index: index + 1,
    score: subtask.score,
    conditionHtml: renderInline(subtask.condition, ctx),
  }));

  const examples = problem.examples.map((example, index) => ({
    index: index + 1,
    input: escapeHtml(example.input.replace(/\s+$/, '')),
    output: escapeHtml(example.output.replace(/\s+$/, '')),
    explanationHtml: example.explanation ? renderRich(example.explanation, ctx) : undefined,
    imageUrl: example.image ? toAssetUrl(example.image, problemDir, ctx, assetsBasePath) : undefined,
  }));

  const view = {
    live: options.live ?? false,
    code: problem.task.code,
    codeHtml: escapeHtml(problem.task.code),
    nameHtml: renderInline(problem.task.name, ctx),
    logoUrl: problem.logo ? toAssetUrl(problem.logo, problemDir, ctx, assetsBasePath) : undefined,
    storyHtml: renderRich(problem.story, ctx),
    inputFormat: problem.input_format.map((line) => renderInline(line, ctx)),
    outputFormat: problem.output_format.map((line) => renderInline(line, ctx)),
    constraints: problem.constraints.map((line) => renderInline(line, ctx)),
    subtasks,
    hasSubtasks: subtasks.length > 0,
    totalScore: subtasks.reduce((sum, s) => sum + s.score, 0),
    examples,
    limits: {
      time: renderInline(problem.limits.time, ctx),
      memory: renderInline(problem.limits.memory, ctx),
    },
    author: problem.author,
    warnings: options.showWarnings ? ctx.warnings : [],
  };

  return { html: getTemplate()(view), problem, warnings: ctx.warnings };
}

/** A readable error page shown instead of the problem page when preview hits a problem */
export function renderErrorPage(err: unknown, live = true): string {
  const isFriendly = err instanceof ProblemError;
  const title = isFriendly ? err.message : 'An unexpected error occurred';
  const file = isFriendly ? err.file : undefined;
  const details = isFriendly ? err.details : [err instanceof Error ? err.message : String(err)];
  const hint = isFriendly
    ? err.hint
    : 'Try saving the file again — if the problem persists, send this message to your administrator';

  const detailList = details.length
    ? `<ul class="error-details">${details.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>`
    : '';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Something went wrong</title>',
    '<link rel="stylesheet" href="/assets/style.css">',
    '</head>',
    '<body class="error-body">',
    '<main class="error-card">',
    '<div class="error-emoji">!</div>',
    `<h1>${escapeHtml(title)}</h1>`,
    file ? `<p class="error-file">File: <code>${escapeHtml(file)}</code></p>` : '',
    detailList,
    hint ? `<p class="error-hint">Fix: ${escapeHtml(hint)}</p>` : '',
    '<p class="error-foot">Fix the file and save — this page will update automatically.</p>',
    '</main>',
    live ? '<script src="/__live-reload.js"></script>' : '',
    '</body>',
    '</html>',
  ].join('\n');
}
