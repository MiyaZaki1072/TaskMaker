/**
 * Converts one problem into a PDF file
 *
 * How it works: open the same server used for preview → have Chromium (Puppeteer) load that page
 * → wait until fonts/images/math are fully rendered → print to PDF.
 * Because it uses the same template + CSS as preview, the result looks exactly the same.
 *
 * Shared by the CLI (scripts/export-pdf.ts, scripts/export-all.ts) and the Studio web app.
 */
import fs from 'node:fs';
import path from 'node:path';
// Type-only import: the full puppeteer package must NOT be loaded at module scope. It ships its
// own Chromium and is only needed for local PDF export; the container uses puppeteer-core against
// the system Chromium instead. Both are imported lazily below.
import type { Browser } from 'puppeteer';
import { ProblemError } from './errors.js';
import { DIST_DIR, loadProblem } from './render.js';
import { startServer } from './server.js';

/** Maximum time to wait for Chromium (milliseconds) — allows for a slow machine or large images */
const RENDER_TIMEOUT = 30_000;

function escapeForTemplate(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Page footer (problem code + page number)
 *
 * Chromium limitation: the header/footer are rendered separately from the main document, and
 * they "load no external fonts at all", even when embedded as a data URI.
 * The only fonts available are ones already installed on that machine.
 * To keep the footer identical across machines (including CI machines with no Thai font),
 * this only uses digits and English letters — no Thai text.
 */
const FOOTER_TEMPLATE = (code: string) => `
<div style="width:100%;font-size:8pt;color:#4a5260;padding:0 14mm;
            font-family:Arial,Helvetica,sans-serif;
            display:flex;justify-content:space-between;align-items:center;">
  <span>${escapeForTemplate(code)}</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

/**
 * Chromium flags every containerised run needs.
 *
 *   --no-sandbox / --disable-setuid-sandbox: Chromium's sandbox needs kernel privileges the
 *     container does not have. The alternative is granting SYS_ADMIN, which is a far bigger hole
 *     than running Chromium unsandboxed on content this app generated itself.
 *   --disable-dev-shm-usage: Docker gives a container 64 MB of /dev/shm by default and Chromium
 *     will happily exceed that rendering an image-heavy problem, crashing the tab mid-print.
 *     This makes it write to /tmp instead. (docker-compose.yml also raises shm_size.)
 *   --font-render-hinting=none: keeps glyph positioning identical to a local export.
 */
const CONTAINER_CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--font-render-hinting=none',
];

export async function launchBrowser(): Promise<Browser> {
  // Self-hosted (ZimaOS): Chromium is installed by the Dockerfile as a system package rather than
  // downloaded by puppeteer, because the distro package is the one that matches the image's
  // architecture and ships with the shared libraries already present. PUPPETEER_EXECUTABLE_PATH
  // is puppeteer's own conventional name for this; CHROME_PATH is accepted as an alias since it
  // is what most self-hosting guides tell people to set.
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.CHROME_PATH;
  if (executablePath) {
    try {
      const puppeteerCore = (await import('puppeteer-core')).default;
      return (await puppeteerCore.launch({
        headless: true,
        executablePath,
        args: CONTAINER_CHROME_ARGS,
      })) as unknown as Browser;
    } catch (err) {
      throw new ProblemError('Could not launch Chromium for PDF export', {
        details: [err instanceof Error ? err.message : String(err)],
        hint: `PUPPETEER_EXECUTABLE_PATH points at "${executablePath}". Check that the file exists inside the container (docker exec … ls -l "${executablePath}"), or open "Preview in new tab" and press Ctrl+P to save as PDF instead.`,
      });
    }
  }

  try {
    const puppeteer = (await import('puppeteer')).default;
    return await puppeteer.launch({
      headless: true,
      args: ['--font-render-hinting=none', '--no-sandbox', '--disable-setuid-sandbox'],
    });
  } catch (err) {
    throw new ProblemError('Could not launch the PDF renderer (Chromium)', {
      details: [err instanceof Error ? err.message : String(err)],
      hint: 'Try running  npx puppeteer browsers install chrome  once (requires internet), then run the same command again — or open Preview in a new tab and press Ctrl+P to save as PDF',
    });
  }
}

export interface ExportResult {
  code: string;
  name: string;
  file: string;
  warnings: string[];
}

/** Generates the PDF for one problem, returns the output path */
export async function exportProblemPdf(problemDir: string, browser: Browser): Promise<ExportResult> {
  const problem = loadProblem(problemDir);
  const server = await startServer(problemDir, { port: 0, live: false, showWarnings: false });
  const page = await browser.newPage();
  const pageErrors: string[] = [];

  try {
    page.on('pageerror', (err: unknown) =>
      pageErrors.push(err instanceof Error ? err.message : String(err)),
    );

    // SSRF protection: block Chromium from making requests outside localhost or reaching cloud metadata endpoints
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        const reqUrl = req.url();
        if (reqUrl.startsWith('data:')) {
          req.continue();
          return;
        }
        const parsed = new URL(reqUrl);
        if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
          req.continue();
        } else {
          req.abort('accessdenied');
        }
      } catch {
        req.abort('accessdenied');
      }
    });

    await page.goto(server.url, { waitUntil: 'networkidle0', timeout: RENDER_TIMEOUT });

    // Wait for a real signal from the page (fonts + images fully loaded), not a guessed delay
    await page.waitForFunction(() => document.documentElement.dataset.renderReady === '1', {
      timeout: RENDER_TIMEOUT,
    });

    // Confirm math was actually rendered by KaTeX, not left as raw $...$ text
    await page.waitForFunction(
      () => {
        const mathNodes = document.querySelectorAll('.katex');
        if (mathNodes.length === 0) return true;
        return document.querySelectorAll('.katex .base, .katex .katex-html').length > 0;
      },
      { timeout: RENDER_TIMEOUT },
    );

    fs.mkdirSync(DIST_DIR, { recursive: true });
    const outFile = path.join(DIST_DIR, `${problem.task.code}.pdf`);

    await page.pdf({
      path: outFile,
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: false,
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: FOOTER_TEMPLATE(problem.task.code),
      margin: { top: '14mm', bottom: '16mm', left: '16mm', right: '16mm' },
    });

    return { code: problem.task.code, name: problem.task.name, file: outFile, warnings: pageErrors };
  } finally {
    await page.close().catch(() => undefined);
    await server.close();
  }
}
