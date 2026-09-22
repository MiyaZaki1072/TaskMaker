/**
 * npm run pdf:all
 * Exports every problem in the problems/ folder in one go, launching Chromium only once
 */
import path from 'node:path';
import { ProblemError, reportAndExit } from '../src/errors.js';
import { listProblemDirs, ROOT } from '../src/render.js';
import { exportProblemPdf, launchBrowser } from '../src/pdf-export.js';

async function main(): Promise<void> {
  const dirs = listProblemDirs();
  if (dirs.length === 0) {
    throw new ProblemError('There are no problems to export yet', {
      hint: 'Create your first problem with  npm run new "problem name"',
    });
  }

  const browser = await launchBrowser();
  const failed: { name: string; message: string }[] = [];
  let done = 0;

  console.log(`\n  Found ${dirs.length} problem(s), generating PDFs ...\n`);

  try {
    for (const dir of dirs) {
      const label = path.relative(ROOT, dir).replace(/\\/g, '/');
      try {
        const result = await exportProblemPdf(dir, browser);
        done += 1;
        console.log(`  [${done}/${dirs.length}] ${label}  ->  dist/${result.code}.pdf`);
      } catch (err) {
        const message = err instanceof ProblemError ? err.toPlainText() : String(err);
        failed.push({ name: label, message });
        console.log(`  [skipped] ${label} — still has an issue`);
      }
    }
  } finally {
    await browser.close();
  }

  console.log('');
  if (failed.length === 0) {
    console.log(`  All ${done} problem(s) succeeded, files are in the dist/ folder\n`);
    return;
  }

  console.log(`  ${done} succeeded / ${failed.length} failed\n`);
  for (const item of failed) {
    console.log(`  Problem ${item.name}`);
    console.log(`${item.message}\n`);
  }
  console.log('  Fix the issues shown above, then run npm run pdf:all again\n');
  process.exit(1);
}

main().catch(reportAndExit);
