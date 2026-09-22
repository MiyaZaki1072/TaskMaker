/**
 * npm run validate
 * Checks that every problem.yaml file is complete and correct
 * If something is missing, prints a plain-English message saying which problem needs what (no stack trace)
 * (the real check logic lives in src/problem-ops.ts, shared with the Studio web app)
 */
import { Command } from 'commander';
import { reportAndExit } from '../src/errors.js';
import { checkProblem } from '../src/problem-ops.js';
import { listProblemDirs, resolveProblemDir } from '../src/render.js';

function main(): void {
  const program = new Command();
  program
    .name('npm run validate')
    .argument('[problem]', 'validate only this problem (if omitted, validates all of them)')
    .parse(process.argv);

  const target = program.args[0];
  const dirs = target ? [resolveProblemDir(target)] : listProblemDirs();

  if (dirs.length === 0) {
    console.log('\n  There are no problems in the problems/ folder yet');
    console.log('  Create your first problem with  npm run new "problem name"\n');
    return;
  }

  console.log(`\n  Validating ${dirs.length} problem(s)\n`);
  const reports = dirs.map(checkProblem);

  for (const report of reports) {
    if (report.ok) {
      console.log(`  [passed] ${report.label}`);
      for (const warning of report.warnings) {
        console.log(`         warning: ${warning}`);
      }
    } else {
      console.log(`  [failed] ${report.label}`);
      console.log(`         ${report.error?.message ?? ''}`);
      for (const detail of report.error?.details ?? []) {
        console.log(`         - ${detail}`);
      }
      if (report.error?.hint) console.log(`         Fix: ${report.error.hint}`);
    }
  }

  const failed = reports.filter((r) => !r.ok);
  const warned = reports.filter((r) => r.ok && r.warnings.length > 0);

  console.log('');
  if (failed.length === 0) {
    console.log(`  All ${reports.length} problem(s) passed validation`);
    if (warned.length > 0) {
      console.log(`  (${warned.length} of them have warnings — PDF export still works, but they should be cleaned up)`);
    }
    console.log('');
    return;
  }

  console.log(`  ${reports.length - failed.length} passed / ${failed.length} need fixing`);
  console.log('  Fix them based on the messages above, then run npm run validate again\n');
  process.exit(1);
}

try {
  main();
} catch (err) {
  reportAndExit(err);
}
