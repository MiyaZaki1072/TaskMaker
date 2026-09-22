/**
 * npm run test:text
 *
 * Two things, in one script:
 *
 * 1. Backward-compat guard: renders the two fixture problems
 *    (test/fixtures/example_path_count, test/fixtures/example_mirror_range) through the full
 *    production pipeline (renderProblem, same code path as preview/PDF) and diffs the HTML against
 *    a saved snapshot. Any byte of difference fails loudly, so a markup change cannot silently
 *    alter how an existing problem renders.
 *
 *    The fixtures are written for this repository rather than taken from a real problem set: the
 *    tool ships without content, and a public repo should not carry someone's unpublished problems.
 *    Between them they still cover what the renderer has to get right — Thai text, KaTeX maths,
 *    images in the story, subtasks, and multi-line examples with and without an explanation.
 *
 *    Run with --update once, deliberately, to accept new output as the new snapshot (e.g. after a
 *    real behavior change was intentionally made and verified by eye).
 *
 * 2. New-syntax checks: small renderRich/renderInline assertions for bold, line breaks, image
 *    size, and alignment — the formatting features being added on top of the existing grammar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, renderInline, renderRich } from '../src/text.js';
import { renderProblem } from '../src/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(ROOT, 'test', 'fixtures');
const SNAPSHOT_DIR = path.join(FIXTURES_DIR, '__snapshots__');
const UPDATE = process.argv.includes('--update');

let failures = 0;

function fail(message: string): void {
  failures += 1;
  console.log(`  [FAIL] ${message}`);
}

function pass(message: string): void {
  console.log(`  [pass] ${message}`);
}

function checkSnapshot(name: string): void {
  const dir = path.join(FIXTURES_DIR, name);
  const snapshotFile = path.join(SNAPSHOT_DIR, `${name}.html`);
  const { html } = renderProblem(dir, { live: false, showWarnings: false, assetsBasePath: '/problem-assets' });

  if (UPDATE || !fs.existsSync(snapshotFile)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(snapshotFile, html, 'utf8');
    pass(`${name}: snapshot written (${html.length} bytes)`);
    return;
  }

  const baseline = fs.readFileSync(snapshotFile, 'utf8');
  if (html === baseline) {
    pass(`${name}: renders byte-identical to the saved snapshot`);
  } else {
    fail(`${name}: rendered HTML no longer matches the saved snapshot — this problem's output changed`);
    const baseLines = baseline.split('\n');
    const newLines = html.split('\n');
    for (let i = 0; i < Math.max(baseLines.length, newLines.length); i += 1) {
      if (baseLines[i] !== newLines[i]) {
        console.log(`         first diff at line ${i + 1}:`);
        console.log(`         - ${baseLines[i] ?? '(missing)'}`);
        console.log(`         + ${newLines[i] ?? '(missing)'}`);
        break;
      }
    }
  }
}

function checkInline(label: string, input: string, expected: string): void {
  const ctx = createContext();
  const actual = renderInline(input, ctx);
  if (actual === expected) {
    pass(label);
  } else {
    fail(`${label}\n         input:    ${JSON.stringify(input)}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
  }
}

function checkRich(label: string, input: string, expected: string): void {
  const ctx = createContext();
  const actual = renderRich(input, ctx);
  if (actual === expected) {
    pass(label);
  } else {
    fail(`${label}\n         input:    ${JSON.stringify(input)}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
  }
}

console.log('\n  Backward-compat: real stored problems render unchanged\n');
checkSnapshot('example_path_count');
checkSnapshot('example_mirror_range');

console.log('\n  New syntax: bold, line break, image size, alignment\n');

checkInline('bold renders as <strong>', 'this is [b]bold[/b] text', 'this is <strong>bold</strong> text');
checkInline('unclosed [b] is left literal, never crashes', 'oops [b]never closed', 'oops [b]never closed');
checkInline('line break renders as <br>', 'first line[br]second line', 'first line<br>second line');
checkInline('content inside bold is still HTML-escaped', '[b]<script>[/b]', '<strong>&lt;script&gt;</strong>');

checkRich(
  'image size: third pipe field becomes explicit width, old two-field syntax still has none',
  '[img: assets/a.png | caption]\n\n[img: assets/b.png | caption | 300]',
  [
    '<figure class="story-figure"><img src="assets/a.png" alt="caption"><figcaption>caption</figcaption></figure>',
    '<figure class="story-figure" style="width:300px"><img src="assets/b.png" alt="caption" style="width:300px"><figcaption>caption</figcaption></figure>',
  ].join('\n'),
);

checkRich(
  'alignment wraps the contiguous blocks between markers',
  '[center]\ncentered paragraph\n[/center]\n\nnormal paragraph',
  [
    '<div class="align-center"><p>centered paragraph</p></div>',
    '<p>normal paragraph</p>',
  ].join('\n'),
);

checkRich(
  'unclosed [center] wraps to the end rather than crashing or dropping content',
  '[center]\nfirst\n\nsecond',
  '<div class="align-center"><p>first</p>\n<p>second</p></div>',
);

console.log('');
if (failures > 0) {
  console.log(`  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('  All checks passed\n');
