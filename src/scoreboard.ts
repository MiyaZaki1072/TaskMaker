/**
 * Scoreboard maker: turns the ranking CMS lets an admin download (Ranking → "txt" or "csv") into a
 * printable scoreboard — contest title, authors, one column per problem, rows sorted by total and
 * coloured by medal.
 *
 * Everything is derived from the uploaded text on each request; nothing is stored. The same HTML
 * feeds the studio's live preview and the PDF, so the two cannot drift apart.
 */
import { type Browser } from 'puppeteer';
import { startPageServer } from './booklet.js';
import { ProblemError } from './errors.js';
import { waitForRenderReady } from './pdf-export.js';
import { stitchPngs } from './png-stitch.js';
import { escapeHtml } from './text.js';

export interface RankingRow {
  username: string;
  /** Full name from the CMS "User" column; falls back to the username when CMS has none */
  name: string;
  scores: number[];
  total: number;
}

export interface Ranking {
  /** Task short names, in the order CMS lists them */
  problems: string[];
  rows: RankingRow[];
}

export type Medal = 'gold' | 'silver' | 'bronze';

/** Minimum total for each medal; a missing value means that medal is not awarded */
export interface MedalCutoffs {
  gold?: number;
  silver?: number;
  bronze?: number;
}

export interface ScoreboardOptions {
  contestName?: string;
  /** One author per line */
  authors?: string;
  cutoffs: MedalCutoffs;
}

export interface ScoreboardRow extends RankingRow {
  medal: Medal | null;
}

export interface Scoreboard {
  problems: string[];
  rows: ScoreboardRow[];
  options: ScoreboardOptions;
}

/** Guards against a pasted file that is not a ranking at all, or one big enough to stall Chromium */
const MAX_CONTESTANTS = 2000;
const MAX_TASKS = 40;
/** From this many problem columns an A4 page is printed sideways so the table still fits */
const LANDSCAPE_FROM = 9;

const SCORE = /^-?\d+(?:\.\d+)?$/;
/** Header cells that are not problems. "P" is the partial-score marker column CMS can add after each score */
const NON_PROBLEM_COLUMNS = new Set(['Username', 'User', 'Team', 'Global', 'P']);

function notARanking(details: string[]): ProblemError {
  return new ProblemError('This does not look like a CMS ranking file', {
    details,
    hint: 'In CMS admin, open the contest → Ranking → download it as "txt" or "csv", then upload that file unchanged',
  });
}

/** CMS marks a partial score with a trailing "*"; the number is what matters here */
function parseScore(token: string): number | null {
  const cleaned = token.trim().replace(/\*$/, '');
  return SCORE.test(cleaned) ? Number(cleaned) : null;
}

/**
 * The txt download is space-padded columns: Username, User (full name — may contain spaces),
 * optional Team, one column per task, then Global. The columns are not a dependable fixed width (a
 * name longer than its field pushes the rest of the row right), so rows are read from the right
 * instead: the last tokens are the scores, the first is the username, and whatever sits between is
 * the name.
 */
function parseTxt(lines: string[]): Ranking {
  const header = lines[0]!.trim().split(/\s+/);
  if (header[0] !== 'Username' || header[1] !== 'User' || header.at(-1) !== 'Global') {
    throw notARanking([`The first line should start with "Username User" and end with "Global", but it is: ${lines[0]!.trim()}`]);
  }
  const hasTeam = header[2] === 'Team';
  const problems = header.slice(hasTeam ? 3 : 2, -1).filter((cell) => !NON_PROBLEM_COLUMNS.has(cell));
  const scoreCount = problems.length + 1;

  const rows: RankingRow[] = [];
  lines.slice(1).forEach((line, index) => {
    if (!line.trim()) return;
    const tokens = line.trim().split(/\s+/).filter((token) => token !== '*');
    // At least a username, then (with teams) the team, then every score
    if (tokens.length < 1 + (hasTeam ? 1 : 0) + scoreCount) {
      throw notARanking([`Line ${index + 2} has fewer columns than the header: ${line.trim()}`]);
    }
    const scores = tokens.slice(-scoreCount).map(parseScore);
    if (scores.some((score) => score === null)) {
      throw notARanking([`Line ${index + 2} has a score that is not a number: ${line.trim()}`]);
    }
    const numbers = scores as number[];
    const username = tokens[0]!;
    const nameEnd = tokens.length - scoreCount - (hasTeam ? 1 : 0);
    const name = tokens.slice(1, nameEnd).join(' ') || username;
    rows.push({ username, name, scores: numbers.slice(0, -1), total: numbers.at(-1)! });
  });

  return { problems, rows };
}

/** Splits CSV into rows of cells (RFC 4180: quoted cells may hold commas, quotes and newlines) */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((c) => c.trim()));
}

function parseCsv(text: string): Ranking {
  const [header, ...body] = splitCsv(text);
  const cells = header!.map((cell) => cell.trim());
  const userIdx = cells.indexOf('User');
  const globalIdx = cells.indexOf('Global');
  if (cells[0] !== 'Username' || userIdx < 0 || globalIdx < 0) {
    throw notARanking([`The header row should contain "Username", "User" and "Global", but it is: ${cells.join(', ')}`]);
  }
  const problemIdx = cells
    .map((cell, idx) => (idx < globalIdx && !NON_PROBLEM_COLUMNS.has(cell) ? idx : -1))
    .filter((idx) => idx >= 0);

  const rows = body.map((row, index): RankingRow => {
    const read = (idx: number): number => {
      const score = parseScore(row[idx] ?? '');
      if (score === null) {
        throw notARanking([`Row ${index + 2}, column "${cells[idx]}" is not a number: ${row[idx] || '(empty)'}`]);
      }
      return score;
    };
    const username = (row[0] ?? '').trim();
    return {
      username,
      name: (row[userIdx] ?? '').trim() || username,
      scores: problemIdx.map(read),
      total: read(globalIdx),
    };
  });

  return { problems: problemIdx.map((idx) => cells[idx]!), rows };
}

/** Reads a CMS ranking download, in either of the two formats CMS offers */
export function parseCmsRanking(text: string): Ranking {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) {
    throw new ProblemError('The ranking is empty', { hint: 'Upload the ranking file downloaded from CMS, or paste its contents' });
  }

  const ranking = /^\s*"?Username"?\s*,/.test(lines[first]!)
    ? parseCsv(lines.slice(first).join('\n'))
    : parseTxt(lines.slice(first));

  if (ranking.problems.length === 0) {
    throw notARanking(['The header has no problem columns between "User" and "Global"']);
  }
  if (ranking.problems.length > MAX_TASKS) {
    throw new ProblemError(`The ranking has ${ranking.problems.length} problems — the scoreboard supports at most ${MAX_TASKS}`);
  }
  if (ranking.rows.length > MAX_CONTESTANTS) {
    throw new ProblemError(`The ranking has ${ranking.rows.length} contestants — the scoreboard supports at most ${MAX_CONTESTANTS}`);
  }
  return ranking;
}

/** Reads one cutoff from a request: blank means "not awarded", anything else must be a number of 0 or more */
export function parseCutoff(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return undefined;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number) || number < 0) {
    throw new ProblemError(`The ${label} minimum score must be a number of 0 or more`, { details: [`Got: ${String(value)}`] });
  }
  return number;
}

function checkCutoffOrder(cutoffs: MedalCutoffs): void {
  const given = (['gold', 'silver', 'bronze'] as const).filter((medal) => cutoffs[medal] !== undefined);
  for (let i = 1; i < given.length; i += 1) {
    const higher = given[i - 1]!;
    const lower = given[i]!;
    if (cutoffs[higher]! < cutoffs[lower]!) {
      throw new ProblemError(`The ${higher} minimum score must be at least the ${lower} minimum score`, {
        details: [`${higher}: ${cutoffs[higher]}, ${lower}: ${cutoffs[lower]}`],
      });
    }
  }
}

/** CMS rounds scores to a couple of decimals, so compare with a hair of tolerance */
function medalFor(total: number, cutoffs: MedalCutoffs): Medal | null {
  const reaches = (cutoff: number | undefined) => cutoff !== undefined && total >= cutoff - 1e-9;
  if (reaches(cutoffs.gold)) return 'gold';
  if (reaches(cutoffs.silver)) return 'silver';
  if (reaches(cutoffs.bronze)) return 'bronze';
  return null;
}

/** Sorts by total (highest first, ties by name) and assigns medals by minimum score */
export function buildScoreboard(ranking: Ranking, options: ScoreboardOptions): Scoreboard {
  checkCutoffOrder(options.cutoffs);
  const rows = ranking.rows
    .map((row) => ({ ...row, medal: medalFor(row.total, options.cutoffs) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, 'th'));
  return { problems: ranking.problems, rows, options };
}

export interface ScoreStats {
  mean: number;
  median: number;
  /** Population standard deviation: the scoreboard describes everyone who sat the contest, not a sample */
  sd: number;
  max: number;
}

/** Summary of the contestants' totals; null when the ranking has no contestants */
export function scoreStats(totals: number[]): ScoreStats | null {
  if (totals.length === 0) return null;
  const sorted = [...totals].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((sum, x) => sum + x, 0) / n;
  const middle = Math.floor(n / 2);
  const median = n % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  const sd = Math.sqrt(sorted.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n);
  return { mean, median, sd, max: sorted[n - 1]! };
}

function formatScore(score: number): string {
  return String(Math.round(score * 100) / 100);
}

const MEDAL_LABEL: Record<Medal, string> = {
  gold: 'เหรียญทอง',
  silver: 'เหรียญเงิน',
  bronze: 'เหรียญทองแดง',
};

const RENDER_READY_SCRIPT = `<script>
(async () => {
  try { await document.fonts.ready; } catch (err) { /* older browser without document.fonts */ }
  document.documentElement.setAttribute('data-render-ready', '1');
})();
</script>`;

function isLandscape(scoreboard: Scoreboard): boolean {
  return scoreboard.problems.length >= LANDSCAPE_FROM;
}

/**
 * The scoreboard page. `forPrint` adds the render-ready signal the PDF renderer waits for; the
 * studio preview leaves it out because its frame is sandboxed without scripts.
 *
 * Medals are shown by grouping, not by colour alone: each medal's rows sit under one band that
 * names the medal, its cutoff and how many won it. That survives a black-and-white printer (where
 * the three tints collapse into near-identical greys) without repeating a label on every row.
 */
export function scoreboardHtml(scoreboard: Scoreboard, forPrint = false): string {
  const { contestName, authors, cutoffs } = scoreboard.options;
  const authorNames = (authors ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const landscape = isLandscape(scoreboard);
  const columns = scoreboard.problems.length + 2;

  const medalCount: Record<Medal, number> = { gold: 0, silver: 0, bronze: 0 };
  for (const row of scoreboard.rows) if (row.medal) medalCount[row.medal] += 1;

  const band = (medal: Medal) =>
    `<tr class="sb-band sb-band-${medal}"><td colspan="${columns}"><span class="sb-dot sb-dot-${medal}"></span>` +
    `<strong>${MEDAL_LABEL[medal]}</strong><span class="sb-band-meta">คะแนนรวม ≥ ${formatScore(cutoffs[medal]!)} · ${medalCount[medal]} คน</span></td></tr>`;

  // Everyone below the medal cutoffs gets a group of their own (blue, with an ice cream) — but only
  // when medals are being awarded at all; with no cutoffs there is nothing to be "below".
  const awardsMedals = cutoffs.gold !== undefined || cutoffs.silver !== undefined || cutoffs.bronze !== undefined;
  const restCount = scoreboard.rows.filter((row) => !row.medal).length;
  const restBand =
    `<tr class="sb-band sb-band-rest"><td colspan="${columns}"><span class="sb-emoji">🍦</span>` +
    `<strong>ผู้เข้าร่วมการแข่งขัน</strong><span class="sb-band-meta">${restCount} คน</span></td></tr>`;

  const body: string[] = [];
  let group: Medal | null | undefined;
  for (const row of scoreboard.rows) {
    if (row.medal !== group) {
      if (row.medal) body.push(band(row.medal));
      else if (awardsMedals) body.push(restBand);
      group = row.medal;
    }
    const cells = row.scores
      .map((score) => `<td class="sb-score${score === 0 ? ' sb-zero' : ''}">${formatScore(score)}</td>`)
      .join('');
    const rowClass = row.medal ? ` sb-${row.medal}` : awardsMedals ? ' sb-rest' : '';
    body.push(
      `<tr class="sb-row${rowClass}"><td class="sb-name">${escapeHtml(row.name)}</td>${cells}` +
        `<td class="sb-score sb-total">${formatScore(row.total)}</td></tr>`,
    );
  }

  const head = scoreboard.problems.map((problem) => `<th class="sb-score">${escapeHtml(problem)}</th>`).join('');

  const stats = scoreStats(scoreboard.rows.map((row) => row.total));
  const tiles: Array<[string, string]> = [
    ['ผู้เข้าแข่งขัน', `${scoreboard.rows.length} คน`],
    ['จำนวนข้อ', `${scoreboard.problems.length} ข้อ`],
  ];
  if (stats) {
    tiles.push(
      ['ค่าเฉลี่ย', formatScore(stats.mean)],
      ['มัธยฐาน', formatScore(stats.median)],
      ['S.D.', formatScore(stats.sd)],
      ['คะแนนสูงสุด', formatScore(stats.max)],
    );
  }
  const statTiles = tiles
    .map(([label, value]) => `<div class="sb-stat"><span class="sb-stat-value">${value}</span><span class="sb-stat-label">${label}</span></div>`)
    .join('');

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${escapeHtml(contestName || 'Scoreboard')}</title>
<link rel="stylesheet" href="/assets/style.css">
<style>
  .paper.sb-landscape { --page-width: 297mm; min-height: 210mm; }

  /* ---- Title block ---- */
  .sb-head { padding-bottom: 12px; margin-bottom: 14px; border-bottom: 2px solid var(--accent); }
  /* Set per line: style.css justifies paragraphs, which would override an inherited centre */
  .sb-head > * { text-align: center; }
  /* No letter-spacing: it pulls Thai vowel and tone marks away from their consonants */
  .sb-kicker { margin: 0; font-size: 0.85rem; font-weight: 700; color: var(--accent); }
  .sb-title { margin: 2px 0 4px; font-size: 2.1rem; line-height: 1.15; font-weight: 700; color: var(--ink); }
  .sb-authors { margin: 0; color: var(--ink-soft); }
  /* A strip of figures: value on top, what it is underneath, hairlines between */
  .sb-stats { display: flex; justify-content: center; flex-wrap: wrap; margin: 12px 0 0; }
  .sb-stat { padding: 0 18px; line-height: 1.2; }
  .sb-stat + .sb-stat { border-left: 1px solid var(--line); }
  .sb-stat-value { display: block; font-size: 1.15rem; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
  .sb-stat-label { display: block; font-size: 0.75rem; color: var(--ink-soft); }

  /* ---- Table: horizontal rules only, so the numbers do the talking ---- */
  /* A long scoreboard has to flow across pages; style.css keeps ordinary tables on one page */
  /* Separate, not collapsed, borders: collapsed ones leave hairline seams between cells in the PDF */
  .sb-table { border-collapse: separate; border-spacing: 0; break-inside: auto; page-break-inside: auto; margin: 0; font-size: 0.88rem; line-height: 1.3; font-variant-numeric: tabular-nums; }
  .sb-table th, .sb-table td { border: none; padding: 3px 10px 4px; vertical-align: middle; }
  .sb-table thead th { background: var(--accent); color: #fff; font-weight: 700; }
  .sb-table .sb-name { text-align: left; }
  .sb-table .sb-score { text-align: center; white-space: nowrap; width: 1%; }
  .sb-table .sb-total { font-weight: 700; border-left: 1px solid var(--line); }
  .sb-table thead .sb-total { border-left-color: rgb(255 255 255 / 35%); }
  .sb-row td { border-bottom: 1px solid var(--line-soft); }
  .sb-zero { color: #8a93a0; }

  /* ---- Medal groups: a band names the medal; its rows carry the tint and a coloured edge ---- */
  .sb-band td { padding: 10px 10px 4px; background: #fff; font-size: 0.95rem; border-bottom: 1.5px solid; }
  .sb-band strong { margin-right: 10px; }
  .sb-band-meta { color: var(--ink-soft); font-size: 0.9em; }
  .sb-band-gold td { border-bottom-color: #d4a72c; }
  .sb-band-silver td { border-bottom-color: #9aa4b2; }
  .sb-band-bronze td { border-bottom-color: #b8743f; }
  .sb-dot { display: inline-block; width: 0.7em; height: 0.7em; border-radius: 50%; margin-right: 8px; }
  .sb-dot-gold { background: #d4a72c; }
  .sb-dot-silver { background: #9aa4b2; }
  .sb-dot-bronze { background: #b8743f; }
  .sb-gold td { background: #fdf5d8; }
  .sb-silver td { background: #f0f2f6; }
  .sb-bronze td { background: #fbeadc; }
  .sb-gold .sb-name { box-shadow: inset 4px 0 0 #d4a72c; }
  .sb-silver .sb-name { box-shadow: inset 4px 0 0 #9aa4b2; }
  .sb-bronze .sb-name { box-shadow: inset 4px 0 0 #b8743f; }
  .sb-band-rest td { border-bottom-color: #3b82c4; }
  .sb-rest td { background: #eaf2fb; }
  .sb-rest .sb-name { box-shadow: inset 4px 0 0 #3b82c4; }
  /* The image ships Noto Color Emoji for this; the others cover a local export on Windows or macOS */
  .sb-emoji { margin-right: 6px; font-family: 'Noto Color Emoji', 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif; }

  /* Keep a band with its first row rather than stranding it at the foot of a page */
  .sb-band { break-after: avoid; page-break-after: avoid; }
  @page { size: A4 ${landscape ? 'landscape' : 'portrait'}; }
</style>
</head>
<body>
<article class="paper${landscape ? ' sb-landscape' : ''}">
  <header class="sb-head">
    <p class="sb-kicker">ผลการแข่งขัน</p>
    ${contestName ? `<h1 class="sb-title">${escapeHtml(contestName)}</h1>` : ''}
    ${authorNames.length > 0 ? `<p class="sb-authors">${authorNames.map(escapeHtml).join(' · ')}</p>` : ''}
    <div class="sb-stats">${statTiles}</div>
  </header>
  <table class="sb-table">
    <thead><tr><th class="sb-name">ผู้เข้าแข่งขัน</th>${head}<th class="sb-score sb-total">รวม</th></tr></thead>
    <tbody>
${body.join('\n')}
    </tbody>
  </table>
</article>
${forPrint ? RENDER_READY_SCRIPT : ''}
</body>
</html>`;
}

/**
 * Page numbers only, in a Latin system font: Chromium renders the footer apart from the page and
 * it cannot load the Thai web font (see FOOTER_TEMPLATE in pdf-export.ts).
 */
const SCOREBOARD_FOOTER = `
<div style="width:100%;font-size:8pt;color:#4a5260;padding:0 14mm;font-family:Arial,Helvetica,sans-serif;text-align:right;">
  <span class="pageNumber"></span> / <span class="totalPages"></span>
</div>`;

/** Prints the scoreboard to an A4 PDF with the same fonts as the problem pages */
export async function renderScoreboardPdf(scoreboard: Scoreboard, browser: Browser): Promise<Uint8Array> {
  const server = await startPageServer(() => scoreboardHtml(scoreboard, true));
  const page = await browser.newPage();
  try {
    await page.goto(server.url, { waitUntil: 'load' });
    await waitForRenderReady(page);
    return await page.pdf({
      format: 'A4',
      landscape: isLandscape(scoreboard),
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: SCOREBOARD_FOOTER,
      margin: { top: '14mm', bottom: '16mm', left: '14mm', right: '14mm' },
    });
  } finally {
    await page.close().catch(() => undefined);
    await server.close();
  }
}

/** A4 widths in CSS pixels (96 per inch), so the PNG wraps text exactly where the PDF does */
const A4_WIDTH_PX = { portrait: 794, landscape: 1123 };
/** Rendered at 2x so the image stays sharp when zoomed or projected */
const PNG_SCALE = 2;
/** Strip height in CSS pixels: 4000 device pixels each, well inside what one Chromium capture handles */
const PNG_STRIP = 2000;

/**
 * Renders the whole scoreboard as a single PNG: one continuous image as tall as the table needs,
 * never split into pages or scaled down to fit. Uses print styling and the PDF's margins so it
 * reads the same as the printed version.
 */
export async function renderScoreboardPng(scoreboard: Scoreboard, browser: Browser): Promise<Buffer> {
  const server = await startPageServer(() => scoreboardHtml(scoreboard, true));
  const page = await browser.newPage();
  try {
    const width = A4_WIDTH_PX[isLandscape(scoreboard) ? 'landscape' : 'portrait'];
    await page.emulateMediaType('print');
    await page.setViewport({ width, height: 1000, deviceScaleFactor: PNG_SCALE });
    await page.goto(server.url, { waitUntil: 'load' });
    await waitForRenderReady(page);
    // Print styling drops the on-screen paper frame; give the image the PDF's margins back
    await page.addStyleTag({ content: 'html, body { background: #fff; } body { padding: 14mm; }' });
    // The body, not the document: the document is never shorter than the window, which would pad a
    // short scoreboard with blank space at the bottom
    const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().bottom));

    const strips: Uint8Array[] = [];
    for (let y = 0; y < height; y += PNG_STRIP) {
      strips.push(
        await page.screenshot({
          type: 'png',
          clip: { x: 0, y, width, height: Math.min(PNG_STRIP, height - y) },
          captureBeyondViewport: true,
        }),
      );
    }
    return await stitchPngs(strips);
  } finally {
    await page.close().catch(() => undefined);
    await server.close();
  }
}
