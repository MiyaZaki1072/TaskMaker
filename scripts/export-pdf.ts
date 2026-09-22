/**
 * npm run pdf problems/<problem name>
 * (the real logic lives in src/pdf-export.ts, shared with pdf:all, pdf:booklet, and the Studio web app)
 */
import path from 'node:path';
import { Command } from 'commander';
import { ProblemError, reportAndExit } from '../src/errors.js';
import { exportProblemPdf, launchBrowser } from '../src/pdf-export.js';
import { listProblemDirs, resolveProblemDir, ROOT } from '../src/render.js';

function pickProblem(input: string | undefined): string {
  if (input) return resolveProblemDir(input);
  const dirs = listProblemDirs();
  if (dirs.length === 1) return dirs[0]!;
  if (dirs.length === 0) {
    throw new ProblemError('There are no problems to export yet', {
      hint: 'Create your first problem with  npm run new "problem name"',
    });
  }
  throw new ProblemError('No problem was specified to export', {
    details: dirs.map((dir) => `npm run pdf problems/${path.basename(dir)}`),
    hint: 'To export every problem at once, use  npm run pdf:all',
  });
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .name('npm run pdf')
    .argument('[problem]', 'the problem folder, e.g. problems/Example_Task')
    .parse(process.argv);

  const problemDir = pickProblem(program.args[0]);
  const browser = await launchBrowser();
  try {
    console.log('\n  Generating PDF ...');
    const result = await exportProblemPdf(problemDir, browser);
    console.log(`  Done: ${path.relative(ROOT, result.file).replace(/\\/g, '/')}\n`);
  } finally {
    await browser.close();
  }
}

main().catch(reportAndExit);
