/**
 * npm test
 *
 * Runs every regression test that CI runs, one after another, and reports all failures at the end
 * rather than stopping at the first one. This list is the single source of truth: CI calls
 * `npm test` too, so a test added here is automatically enforced on pull requests.
 *
 * Each test is its own process, because several of them set environment variables that
 * src/render.ts reads once at import time (PROBLEMS_DIR, STUDIO_PASSWORD, …).
 *
 * Not included: test:assets, which needs a live database — run it by hand, see its header.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

const TESTS: { file: string; covers: string }[] = [
  { file: 'text-regression.ts', covers: 'text and maths rendering' },
  { file: 'ranking-regression.ts', covers: 'scoreboard maker' },
  { file: 'verify-zip.ts', covers: 'ZIP export / import' },
  { file: 'library-regression.ts', covers: 'global library' },
  { file: 'verify-security.ts', covers: 'auth, CSRF, upload and rate limits' },
];

const results: { file: string; covers: string; ok: boolean; seconds: string }[] = [];

for (const test of TESTS) {
  console.log(`\n━━━ ${test.file} — ${test.covers} ━━━\n`);
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(TEST_DIR, test.file)], {
    stdio: 'inherit',
  });
  results.push({ ...test, ok: run.status === 0, seconds: ((Date.now() - started) / 1000).toFixed(1) });
}

console.log('\n━━━ Summary ━━━\n');
for (const r of results) {
  console.log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.file.padEnd(24)} ${r.seconds.padStart(5)}s  ${r.covers}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} test files failed.\n` : `\nAll ${results.length} test files passed.\n`);
process.exitCode = failed ? 1 : 0;
