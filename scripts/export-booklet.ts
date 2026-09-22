/**
 * npm run pdf:booklet
 * (the real logic lives in src/booklet.ts, shared with the Studio web app)
 */
import path from 'node:path';
import { reportAndExit } from '../src/errors.js';
import { launchBrowser } from '../src/pdf-export.js';
import { listProblemDirs, ROOT } from '../src/render.js';
import { buildBooklet } from '../src/booklet.js';

async function main(): Promise<void> {
  const dirs = listProblemDirs();
  const browser = await launchBrowser();
  try {
    const result = await buildBooklet(dirs, browser, (msg) => console.log(`  ${msg}`));
    console.log(`\n  Done: ${path.relative(ROOT, result.file).replace(/\\/g, '/')}`);
    console.log(`  Total pages: ${result.pageCount}\n`);
  } finally {
    await browser.close();
  }
}

main().catch(reportAndExit);
