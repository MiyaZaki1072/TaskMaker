/**
 * npm run new "problem name"
 * Creates a new problem folder from the template, with an assets/ folder for images
 * (the real logic lives in src/problem-ops.ts, shared with the Studio web app)
 */
import { Command } from 'commander';
import { reportAndExit } from '../src/errors.js';
import { createProblem } from '../src/problem-ops.js';

function main(): void {
  const program = new Command();
  program
    .name('npm run new')
    .argument('[problem name...]', 'the problem folder name/code, e.g. PrePosn2_Tree')
    .parse(process.argv);

  const rawName = program.args.join(' ');
  const { relative } = createProblem(rawName);

  console.log(`\nNew problem created: ${relative}`);
  console.log('\nNext steps');
  console.log(`  1) Open  ${relative}/problem.yaml  and edit the content for your problem`);
  console.log(`  2) Put any images in the  ${relative}/assets/  folder`);
  console.log(`  3) See a live preview with  npm run preview ${relative}`);
  console.log(`  4) When you're happy with it, run  npm run pdf ${relative}\n`);
  console.log('  (or use the web dashboard for all of this instead, with  npm run studio)\n');
}

try {
  main();
} catch (err) {
  reportAndExit(err);
}
