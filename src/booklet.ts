/**
 * Combines PDFs of multiple problems into a single booklet with a table of contents (for printing at exam venues)
 * Shared by the CLI (scripts/export-booklet.ts) and the Studio web app
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { PDFDocument } from 'pdf-lib';
import { type Browser } from 'puppeteer';
import { ProblemError } from './errors.js';
import { exportProblemPdf, mapConcurrent, PDF_CONCURRENCY, waitForRenderReady, type ExportResult } from './pdf-export.js';
import { DIST_DIR, ROOT } from './render.js';
import { escapeHtml } from './text.js';

export interface BookletOptions {
  contestName?: string;
  logo?: string;        // data URI (base64) or URL
  authors?: string;
  rules?: string;
}

interface TocEntry extends ExportResult {
  startPage: number;
  pageCount: number;
}

/**
 * A throwaway local server for one generated page (booklet cover, table of contents, scoreboard), so
 * Chromium can load the fonts from assets/ the same way the problem pages do
 */
export async function startPageServer(getHtml: () => string): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.get('/', (_req, res) => {
    res.type('html').send(getHtml());
  });
  app.use('/assets', express.static(path.join(ROOT, 'assets')));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Turns the free-text rules into paragraphs and lists: lines starting with "1." / "1)" become a numbered
 * list and lines starting with "-" / "•" / "*" a bulleted one, so a wrapped item lines up under its own text
 */
function rulesToHtml(rules: string): string {
  const blocks: string[] = [];
  let listTag: 'ol' | 'ul' | null = null;
  let items: string[] = [];

  const flushList = () => {
    if (listTag) blocks.push(`<${listTag}>${items.join('')}</${listTag}>`);
    listTag = null;
    items = [];
  };

  for (const rawLine of rules.split(/\r?\n/)) {
    const line = rawLine.trim();
    const numbered = /^(\d+)[.)]\s+(.+)$/.exec(line);
    const bullet = /^[-•*]\s+(.+)$/.exec(line);

    if (numbered) {
      if (listTag !== 'ol') flushList();
      listTag = 'ol';
      items.push(`<li value="${Number(numbered[1])}">${escapeHtml(numbered[2] ?? '')}</li>`);
    } else if (bullet) {
      if (listTag !== 'ul') flushList();
      listTag = 'ul';
      items.push(`<li>${escapeHtml(bullet[1] ?? '')}</li>`);
    } else {
      flushList();
      if (line) blocks.push(`<p>${escapeHtml(line)}</p>`);
    }
  }
  flushList();
  return blocks.join('');
}

function coverHtml(options: BookletOptions): string {
  const logoHtml = options.logo ? `<img src="${escapeHtml(options.logo)}" alt="Logo" class="cover-logo" />` : '';
  const rulesHtml = options.rules
    ? `<section class="cover-rules"><h2 class="cover-rules-title">คำชี้แจง / กติกา</h2><div class="cover-rules-content">${rulesToHtml(options.rules)}</div></section>`
    : '';
  const authorsList = options.authors
    ? options.authors.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const authorsHtml = authorsList.length > 0
    ? `<div class="cover-authors">
        <div class="cover-authors-label">ผู้ออกโจทย์</div>
        <div class="cover-author-list">${authorsList.map((a) => `<span class="cover-author">${escapeHtml(a)}</span>`).join('')}</div>
      </div>`
    : '';

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.contestName || 'Cover')}</title>
<link rel="stylesheet" href="/assets/style.css">
<style>
  .cover-container { display: flex; flex-direction: column; min-height: 240mm; padding: 0 6mm; }
  .cover-header { text-align: center; margin-top: 30mm; }
  .cover-logo { max-height: 120px; object-fit: contain; margin-bottom: 28px; }
  .cover-title { font-size: 2.4rem; line-height: 1.3; color: var(--accent); margin: 0; font-weight: 700; }
  .cover-title::after { content: ''; display: block; width: 64px; height: 3px; margin: 18px auto 0; background: var(--accent); border-radius: 2px; }

  .cover-authors { margin-top: 26px; }
  .cover-authors-label { font-size: 0.95rem; font-weight: 700; color: var(--ink-soft); letter-spacing: 0.04em; margin-bottom: 4px; }
  /* One centered line of names that wraps when it runs out of room. The dots sit in the gap (absolutely
     positioned, so they never change where a line breaks) and the script below hides the dot in front of
     the first name on each line. */
  .cover-author-list { display: flex; flex-wrap: wrap; justify-content: center; column-gap: 1.6em; row-gap: 2px; font-size: 1.15rem; line-height: 1.5; color: var(--ink); }
  .cover-author { position: relative; white-space: nowrap; }
  .cover-author + .cover-author::before { content: '\\00B7'; position: absolute; left: -0.8em; transform: translateX(-50%); color: var(--accent); font-weight: 700; }
  .cover-author.line-start::before { display: none; }

  .cover-rules { margin-top: auto; padding: 14px 22px 16px; background: var(--surface); border-left: 4px solid var(--accent); border-radius: 0 6px 6px 0; break-inside: avoid; page-break-inside: avoid; }
  .cover-rules-title { font-size: 1.15rem; line-height: 1.4; font-weight: 700; color: var(--accent); margin: 0 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  .cover-rules-content { font-size: 1rem; line-height: 1.55; color: var(--ink); }
  .cover-rules-content p { margin: 0 0 4px; }
  .cover-rules-content ol, .cover-rules-content ul { margin: 2px 0 6px; padding-left: 1.7em; }
  .cover-rules-content li { margin: 2px 0; padding-left: 0.2em; }
  .cover-rules-content ol li::marker { font-weight: 700; color: var(--accent); }
  .cover-rules-content ul li::marker { color: var(--accent); }
  .cover-rules-content > :last-child { margin-bottom: 0; }
</style>
</head>
<body>
<article class="paper">
  <div class="cover-container">
    <div class="cover-header">
      ${logoHtml}
      <h1 class="cover-title">${escapeHtml(options.contestName || '')}</h1>
      ${authorsHtml}
    </div>
    ${rulesHtml}
  </div>
</article>
<script>
(async () => {
  try { await document.fonts.ready; } catch (err) { /* older browser without document.fonts */ }
  // Hide the separator dot in front of whichever name starts a wrapped line
  let prevTop = null;
  for (const el of document.querySelectorAll('.cover-author')) {
    if (prevTop !== null && el.offsetTop > prevTop) el.classList.add('line-start');
    prevTop = el.offsetTop;
  }
  document.documentElement.setAttribute('data-render-ready', '1');
})();
</script>
</body>
</html>`;
}

function tocHtml(entries: TocEntry[], title: string): string {
  const rows = entries
    .map(
      (entry, idx) => `<tr>
        <td class="toc-num">${idx + 1}</td>
        <td class="toc-name">${escapeHtml(entry.name)}</td>
        <td class="toc-page">${entry.startPage}</td>
      </tr>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>สารบัญ</title>
<link rel="stylesheet" href="/assets/style.css">
<style>
  .toc-title { text-align: center; font-size: 2.1rem; color: var(--accent); margin: 0 0 4px; }
  .toc-sub { text-align: center; color: var(--ink-soft); margin: 0 0 22px; }
  .toc-table td { padding: 8px 12px; }
  .toc-num { width: 5em; text-align: center; font-weight: 600; color: var(--ink-soft); }
  .toc-name { font-size: 1.05rem; font-weight: 600; }
  .toc-page { width: 5em; text-align: center; font-weight: 600; }
</style>
</head>
<body>
<article class="paper">
  <h1 class="toc-title">${escapeHtml(title)}</h1>
  <p class="toc-sub">รวมโจทย์ทั้งหมด ${entries.length} ข้อ</p>
  <table class="toc-table">
    <thead><tr><th style="width: 5em; text-align: center;">ข้อที่</th><th>ชื่อโจทย์</th><th style="width: 5em; text-align: center;">หน้า</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</article>
<script>
(async () => {
  try { await document.fonts.ready; } catch (err) { /* older browser without document.fonts */ }
  document.documentElement.setAttribute('data-render-ready', '1');
})();
</script>
</body>
</html>`;
}

async function renderCover(browser: Browser, html: string): Promise<Uint8Array> {
  const server = await startPageServer(() => html);
  const page = await browser.newPage();
  try {
    await page.goto(server.url, { waitUntil: 'load' });
    await waitForRenderReady(page);
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '16mm', left: '16mm', right: '16mm' },
    });
  } finally {
    await page.close().catch(() => undefined);
    await server.close();
  }
}

async function renderToc(browser: Browser, html: string): Promise<Uint8Array> {
  const server = await startPageServer(() => html);
  const page = await browser.newPage();
  try {
    await page.goto(server.url, { waitUntil: 'load' });
    await waitForRenderReady(page);
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', bottom: '16mm', left: '16mm', right: '16mm' },
    });
  } finally {
    await page.close().catch(() => undefined);
    await server.close();
  }
}

export interface BookletPart {
  code: string;
  name: string;
  pageCount: number;
}

export interface BookletResult {
  file: string;
  pageCount: number;
  parts: BookletPart[];
}

/** Combines the PDFs of the given problems into a single booklet with a table of contents, returns the output path */
export async function buildBooklet(
  dirs: string[],
  browser: Browser,
  onProgress: (message: string) => void = () => undefined,
  options?: BookletOptions
): Promise<BookletResult> {
  if (dirs.length === 0) {
    throw new ProblemError('There are no problems to combine into a booklet yet', {
      hint: 'Create your first problem with  npm run new "problem name"',
    });
  }

  onProgress(`Generating PDFs for ${dirs.length} problems ...`);
  // The cover depends on nothing else, so it renders alongside the problems rather than after them.
  const [parts, coverBytes] = await Promise.all([
    mapConcurrent(dirs, PDF_CONCURRENCY, async (dir): Promise<{ result: ExportResult; pageCount: number }> => {
      const result = await exportProblemPdf(dir, browser);
      const pageCount = (await PDFDocument.load(result.bytes)).getPageCount();
      onProgress(`- ${result.code} (${pageCount} pages)`);
      return { result, pageCount };
    }),
    options?.contestName ? renderCover(browser, coverHtml(options)) : Promise.resolve(null),
  ]);

  const coverPageCount = coverBytes ? (await PDFDocument.load(coverBytes)).getPageCount() : 0;

  // The table-of-contents page count affects its own page numbers, so loop until the number settles
  onProgress('Building the table of contents ...');
  let tocPageCount = 1;
  let tocBytes: Uint8Array = new Uint8Array();

  for (let attempt = 0; attempt < 4; attempt += 1) {
    let cursor = coverPageCount + tocPageCount + 1;
    const entries: TocEntry[] = parts.map(({ result, pageCount }) => {
      const entry = { ...result, pageCount, startPage: cursor };
      cursor += pageCount;
      return entry;
    });

    const title = options?.contestName || 'สารบัญโจทย์';
    tocBytes = await renderToc(browser, tocHtml(entries, title));
    const rendered = await PDFDocument.load(tocBytes);
    if (rendered.getPageCount() === tocPageCount) break;
    tocPageCount = rendered.getPageCount();
  }

  const booklet = await PDFDocument.create();
  
  if (coverBytes) {
    const coverDoc = await PDFDocument.load(coverBytes);
    const coverPages = await booklet.copyPages(coverDoc, coverDoc.getPageIndices());
    for (const page of coverPages) booklet.addPage(page);
  }

  const tocDoc = await PDFDocument.load(tocBytes);
  const tocPages = await booklet.copyPages(tocDoc, tocDoc.getPageIndices());
  for (const page of tocPages) booklet.addPage(page);

  for (const { result } of parts) {
    const doc = await PDFDocument.load(result.bytes);
    const pages = await booklet.copyPages(doc, doc.getPageIndices());
    for (const page of pages) booklet.addPage(page);
  }

  fs.mkdirSync(DIST_DIR, { recursive: true });
  const outFile = path.join(DIST_DIR, 'booklet.pdf');
  fs.writeFileSync(outFile, await booklet.save());

  return {
    file: outFile,
    pageCount: booklet.getPageCount(),
    parts: parts.map(({ result, pageCount }) => ({ code: result.code, name: result.name, pageCount })),
  };
}
