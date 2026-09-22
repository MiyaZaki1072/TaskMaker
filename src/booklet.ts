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
import { exportProblemPdf, type ExportResult } from './pdf-export.js';
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

/** A small server for the table-of-contents page, so it can load fonts from assets/ the same way the problem pages do */
async function startTocServer(getHtml: () => string): Promise<{ url: string; close: () => Promise<void> }> {
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

function coverHtml(options: BookletOptions): string {
  const logoHtml = options.logo ? `<img src="${escapeHtml(options.logo)}" alt="Logo" class="cover-logo" />` : '';
  const rulesHtml = options.rules ? `<div class="cover-rules-box"><div class="cover-rules-title">คำชี้แจง / กติกา</div><div class="cover-rules-content">${escapeHtml(options.rules).replace(/\n/g, '<br>')}</div></div>` : '';
  const authorsList = options.authors
    ? options.authors.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : [];
  const authorsHtml = authorsList.length > 0
    ? `<div class="cover-authors">${authorsList.map((a) => `<div class="cover-author-line">${escapeHtml(a)}</div>`).join('')}</div>`
    : '';

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.contestName || 'Cover')}</title>
<link rel="stylesheet" href="/assets/style.css">
<style>
  .cover-container { display: flex; flex-direction: column; min-height: 80vh; justify-content: space-between; padding: 20px 10px; }
  .cover-header { text-align: center; margin-top: 8vh; }
  .cover-logo { max-height: 120px; object-fit: contain; margin-bottom: 28px; }
  .cover-title { font-size: 2.4rem; color: var(--accent); margin: 0 0 20px; font-weight: 700; }
  .cover-authors { font-size: 1.1rem; color: var(--ink-soft); line-height: 1.35; margin-top: 10px; }
  .cover-author-line { margin: 1px 0; font-weight: 500; }
  .cover-rules-box { border: 2px solid var(--accent); border-radius: 8px; padding: 16px 20px; margin-top: auto; background-color: rgba(0,0,0,0.02); }
  .cover-rules-title { font-weight: bold; font-size: 1.1rem; color: var(--accent); margin-bottom: 8px; }
  .cover-rules-content { font-size: 0.95rem; line-height: 1.6; color: var(--ink); }
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
  const server = await startTocServer(() => html);
  const page = await browser.newPage();
  try {
    await page.goto(server.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.documentElement.dataset.renderReady === '1', {
      timeout: 30_000,
    });
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
  const server = await startTocServer(() => html);
  const page = await browser.newPage();
  try {
    await page.goto(server.url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => document.documentElement.dataset.renderReady === '1', {
      timeout: 30_000,
    });
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
  const parts: { result: ExportResult; pageCount: number }[] = [];

  for (const dir of dirs) {
    const result = await exportProblemPdf(dir, browser);
    const doc = await PDFDocument.load(fs.readFileSync(result.file));
    parts.push({ result, pageCount: doc.getPageCount() });
    onProgress(`- ${result.code} (${doc.getPageCount()} pages)`);
  }
  
  let coverPageCount = 0;
  let coverBytes: Uint8Array | null = null;
  
  if (options?.contestName) {
    onProgress('Building the cover page ...');
    coverBytes = await renderCover(browser, coverHtml(options));
    const coverDoc = await PDFDocument.load(coverBytes);
    coverPageCount = coverDoc.getPageCount();
  }

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
    const doc = await PDFDocument.load(fs.readFileSync(result.file));
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
