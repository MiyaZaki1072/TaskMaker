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

console.log('\n  Word-style formatting: italic, underline, strike, colour, highlight, super/subscript, size\n');

checkInline(
  'each paired code becomes its element',
  '[i]i[/i] [u]u[/u] [s]s[/s] x[sup]2[/sup] a[sub]1[/sub] [hl]h[/hl] [big]B[/big] [small]S[/small]',
  '<em>i</em> <u>u</u> <s>s</s> x<sup>2</sup> a<sub>1</sub> <mark class="text-hl">h</mark> <span class="text-big">B</span> <span class="text-small">S</span>',
);
checkInline('colour from the palette becomes a class', '[color=red]stop[/color]', '<span class="text-red">stop</span>');
checkInline(
  'a colour outside the palette is left as text — no way to inject CSS',
  '[color=red;background:url(x)]x[/color] [color=purple]p[/color]',
  '[color=red;background:url(x)]x[/color] [color=purple]p[/color]',
);
checkInline(
  'codes nest, and math works inside them',
  '[b][color=blue]$n^2$ [i]fast[/i][/color][/b]',
  `<strong><span class="text-blue">${renderInline('$n^2$')} <em>fast</em></span></strong>`,
);
checkInline('the same code nested inside itself closes at the right place', '[b]a [b]b[/b] c[/b]', '<strong>a <strong>b</strong> c</strong>');
checkInline('[s] is not confused with [sup] / [sub] / [small]', '[s]x[/s][sup]y[/sup]', '<s>x</s><sup>y</sup>');
checkInline(
  'an unsupported colour nested inside a real one does not steal its close',
  '[color=red]a [color=purple]b[/color] c',
  '<span class="text-red">a [color=purple]b</span> c',
);

console.log('\n  Tables, headings, dividers\n');

checkRich(
  'a separator row makes the first row a header and sets column alignment',
  '| name | score |\n| --- | :---: |\n| A | 100 |\n| B | 50 |',
  '<table class="rich-table"><thead><tr><th>name</th><th class="cell-center">score</th></tr></thead>' +
    '<tbody><tr><td>A</td><td class="cell-center">100</td></tr><tr><td>B</td><td class="cell-center">50</td></tr></tbody></table>',
);
checkRich(
  'no separator row: every row is a body row',
  '| a | b |\n| c | d |',
  '<table class="rich-table"><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
);
checkRich(
  'short rows are padded so the grid stays rectangular',
  '| a | b | c |\n| d |',
  '<table class="rich-table"><tbody><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>d</td><td></td><td></td></tr></tbody></table>',
);
checkRich(
  'a | inside math, inside an image, or escaped does not split the cell',
  '| $|a-b|$ | [img: assets/x.png | cap] | a \\| b |',
  `<table class="rich-table"><tbody><tr><td>${renderInline('$|a-b|$')}</td><td>${renderInline('[img: assets/x.png | cap]')}</td><td>a | b</td></tr></tbody></table>`,
);
checkRich(
  'cells take inline formatting and are escaped',
  '| [b]<x>[/b] |',
  '<table class="rich-table"><tbody><tr><td><strong>&lt;x&gt;</strong></td></tr></tbody></table>',
);
checkRich(
  'a table ends at the first non-table line',
  'before\n| a |\nafter',
  '<p>before</p>\n<table class="rich-table"><tbody><tr><td>a</td></tr></tbody></table>\n<p>after</p>',
);
checkRich(
  'heading and divider lines',
  '[h]Details[/h]\ntext\n---\nmore',
  '<h3 class="rich-heading">Details</h3>\n<p>text</p>\n<hr class="rich-divider">\n<p>more</p>',
);
checkRich('--- inside a sentence is just text', 'a --- b', '<p>a --- b</p>');

console.log('');
if (failures > 0) {
  console.log(`  ${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('  All checks passed\n');
