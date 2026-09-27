/**
 * npm run test:ranking
 *
 * Checks the scoreboard maker (src/scoreboard.ts) against CMS ranking downloads in
 * test/fixtures/ranking/: reading both the txt and csv formats, sorting, medal cutoffs, and that
 * names reach the HTML escaped; and the PNG strip stitcher. No browser or database needed.
 *
 * The fixtures are synthetic apart from cms-sample.txt, which is the shape of a real CMS export
 * with placeholder users. cms-thai.txt deliberately has a name longer than CMS's padded column, so
 * the row does not line up with the header — the case a fixed-width reader gets wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { ProblemError } from '../src/errors.js';
import { decodePng, stitchPngs } from '../src/png-stitch.js';
import { buildScoreboard, parseCmsRanking, parseCutoff, scoreboardHtml, scoreStats } from '../src/scoreboard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES_DIR = path.join(ROOT, 'test', 'fixtures', 'ranking');

let failures = 0;

function check(condition: boolean, message: string, detail?: unknown): void {
  if (condition) {
    console.log(`  [pass] ${message}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${message}${detail === undefined ? '' : ` — got ${JSON.stringify(detail)}`}`);
  }
}

function expectProblemError(fn: () => unknown, pattern: RegExp, message: string): void {
  try {
    fn();
    check(false, message, 'no error');
  } catch (err) {
    check(err instanceof ProblemError && pattern.test(err.message), message, err instanceof Error ? err.message : err);
  }
}

function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log('CMS sample (cms-sample.txt)');
{
  const ranking = parseCmsRanking(fixture('cms-sample.txt'));
  check(same(ranking.problems, ['test1']), 'one problem, named from the header', ranking.problems);
  check(ranking.rows.length === 2, 'two contestants', ranking.rows.length);
  check(ranking.rows[0]?.name === 't1 t1', 'a full name with a space stays whole', ranking.rows[0]?.name);
  check(ranking.rows[1]?.total === 0, 'total read from Global', ranking.rows[1]?.total);
}

console.log('Thai names, decimals, partial marker, overflowing column (cms-thai.txt)');
{
  const ranking = parseCmsRanking(fixture('cms-thai.txt'));
  check(same(ranking.problems, ['tree', 'path_count', 'mirror']), 'three problems in CMS order', ranking.problems);
  const byUser = new Map(ranking.rows.map((row) => [row.username, row]));
  check(byUser.get('u01')?.name === 'สมชาย ใจดี', 'Thai name with a space', byUser.get('u01')?.name);
  check(same(byUser.get('u01')?.scores, [100, 37.5, 0]), 'decimal score kept', byUser.get('u01')?.scores);
  check(same(byUser.get('u02')?.scores, [100, 100, 40]), 'partial marker "*" dropped from the score', byUser.get('u02')?.scores);
  check(
    byUser.get('u03')?.name === 'นางสาว ชื่อยาวมากเกินความกว้างคอลัมน์ นามสกุลยาว' && same(byUser.get('u03')?.scores, [100, 80, 20]),
    'a name wider than its column does not shift the scores',
    byUser.get('u03'),
  );

  const board = buildScoreboard(ranking, { cutoffs: { gold: 240, silver: 200, bronze: 137.5 } });
  // u01 and u05 tie on 137.5; Thai collation puts Thai script ahead of Latin, so สมชาย before Carol
  check(
    same(board.rows.map((row) => row.username), ['u02', 'u03', 'u01', 'u05', 'u04']),
    'sorted by total, ties by name (Thai collation)',
    board.rows.map((row) => row.username),
  );
  check(
    same(board.rows.map((row) => row.medal), ['gold', 'silver', 'bronze', 'bronze', null]),
    'medal = highest cutoff reached (inclusive), equal totals get the same medal',
    board.rows.map((row) => row.medal),
  );

  const goldOnly = buildScoreboard(ranking, { cutoffs: { gold: 240 } });
  check(goldOnly.rows.filter((row) => row.medal).length === 1, 'a blank cutoff awards no medal of that colour');
}

console.log('CSV download (cms.csv)');
{
  const ranking = parseCmsRanking(fixture('cms.csv'));
  check(same(ranking.problems, ['tree', 'path_count']), '"P" partial columns are not problems', ranking.problems);
  check(ranking.rows[0]?.name === 'Jaidee, Somchai', 'quoted name with a comma', ranking.rows[0]?.name);
  check(ranking.rows[1]?.name === 'Quote "Q" Person', 'escaped quotes inside a name', ranking.rows[1]?.name);
  check(ranking.rows[0]?.total === 137.5, 'total from Global', ranking.rows[0]?.total);
}

console.log('Byte-order mark');
{
  // Excel and some editors prepend one when a file is re-saved; the header must still be found
  const ranking = parseCmsRanking('\uFEFFUsername User t1 Global\nu1 A 5 5\n');
  check(ranking.rows[0]?.total === 5, 'a leading BOM is ignored', ranking.rows[0]);
}

console.log('Rejections');
expectProblemError(() => parseCmsRanking('   \n  '), /empty/, 'empty input');
expectProblemError(() => parseCmsRanking('hello world\n1 2 3'), /CMS ranking/, 'text that is not a ranking');
expectProblemError(() => parseCmsRanking('Username User a Global\nu1 Name x 5\n'), /CMS ranking/, 'a score that is not a number');
expectProblemError(() => parseCutoff('abc', 'gold'), /gold minimum/, 'a cutoff that is not a number');
expectProblemError(() => parseCutoff('-1', 'bronze'), /bronze minimum/, 'a negative cutoff');
check(parseCutoff('', 'gold') === undefined && parseCutoff(' 12.5 ', 'gold') === 12.5, 'blank cutoff is "none", numbers are trimmed');
expectProblemError(
  () => buildScoreboard(parseCmsRanking(fixture('cms-sample.txt')), { cutoffs: { gold: 10, silver: 20 } }),
  /gold minimum score must be at least the silver/,
  'gold below silver',
);

console.log('Score statistics');
{
  const stats = scoreStats([137.5, 240, 200, 0, 137.5]);
  check(stats?.mean === 143 && stats.median === 137.5 && stats.max === 240, 'mean, median (odd count) and max', stats);
  check(Math.abs((stats?.sd ?? 0) - Math.sqrt(6633.5)) < 1e-9, 'population standard deviation', stats?.sd);
  check(scoreStats([4, 1, 3, 2])?.median === 2.5, 'median of an even count averages the middle two');
  check(scoreStats([]) === null, 'no contestants, no statistics');

  const html = scoreboardHtml(buildScoreboard(parseCmsRanking(fixture('cms-thai.txt')), { cutoffs: {} }));
  check(
    ['>143<', '>137.5<', '>81.45<', '>240<', '>5 คน<', '>3 ข้อ<'].every((value) => html.includes(value)),
    'the header shows the statistics, rounded to two decimals',
  );
}

console.log('PNG stitching');
{
  // A tiny encoder for the test: RGBA rows, each written with the given PNG filter
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const pngChunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const encode = (width: number, rows: number[][], filters: number[]) => {
    const raw: number[] = [];
    rows.forEach((row, y) => {
      raw.push(filters[y]!);
      row.forEach((value, x) => {
        const left = x >= 4 ? row[x - 4]! : 0;
        const up = y > 0 ? rows[y - 1]![x]! : 0;
        raw.push((value - (filters[y] === 1 ? left : filters[y] === 2 ? up : 0)) & 0xff);
      });
    });
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(rows.length, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', ihdr),
      pngChunk('IDAT', zlib.deflateSync(Buffer.from(raw))),
      pngChunk('IEND', Buffer.alloc(0)),
    ]);
  };

  const top = [[10, 20, 30, 255, 40, 50, 60, 255], [11, 21, 31, 255, 250, 5, 60, 255]];
  const bottom = [[1, 2, 3, 255, 4, 5, 6, 255], [200, 100, 50, 255, 0, 0, 0, 0], [7, 8, 9, 255, 7, 8, 9, 255]];
  const stitched = decodePng(await stitchPngs([encode(2, top, [1, 2]), encode(2, bottom, [0, 1, 2])]));
  check(stitched.width === 2 && stitched.height === 5, 'strips stack to the combined height', [stitched.width, stitched.height]);
  check(same([...stitched.pixels], [...top.flat(), ...bottom.flat()]), 'every pixel survives, in order (Sub and Up filters decoded)');
}

console.log('HTML');
{
  const ranking = parseCmsRanking('Username User t1 Global\nevil <script>alert(1)</script> 5 5\n');
  const html = scoreboardHtml(buildScoreboard(ranking, { contestName: 'Contest <b>', authors: 'A & B\nC', cutoffs: { gold: 5 } }));
  check(!html.includes('<script>alert') && html.includes('&lt;script&gt;'), 'contestant names are escaped');
  check(html.includes('Contest &lt;b&gt;') && html.includes('A &amp; B'), 'contest name and authors are escaped');
  check(html.includes('class="sb-row sb-gold"'), 'medal rows carry their medal class');
  check(html.includes('A4 portrait'), 'a few problems print portrait');

  // Medals are announced once per group by a band, never after each winner's name
  const board = buildScoreboard(parseCmsRanking(fixture('cms-thai.txt')), { cutoffs: { gold: 240, silver: 200, bronze: 137.5 } });
  const grouped = scoreboardHtml(board);
  const order = [...grouped.matchAll(/class="sb-band (sb-band-\w+)"/g)].map((m) => m[1]);
  check(
    same(order, ['sb-band-gold', 'sb-band-silver', 'sb-band-bronze', 'sb-band-rest']),
    'one band per medal in order, then the 🍦 band for everyone without a medal',
    order,
  );
  check(grouped.split('เหรียญทองแดง').length - 1 === 1, 'the medal name appears only in its band, not per row');
  check(grouped.includes('คะแนนรวม ≥ 137.5 · 2 คน'), 'the band states the cutoff and how many won it');
  check(
    grouped.split('🍦').length - 1 === 1 && grouped.includes('class="sb-row sb-rest"') && grouped.includes('>1 คน</span>'),
    'contestants without a medal are blue (sb-rest) under a single 🍦 band with their count',
  );

  // Nobody reaches any cutoff: everyone is in the 🍦 group
  const allRest = scoreboardHtml(buildScoreboard(parseCmsRanking(fixture('cms-thai.txt')), { cutoffs: { gold: 1000 } }));
  const allRestOrder = [...allRest.matchAll(/class="sb-band (sb-band-\w+)"/g)].map((m) => m[1]);
  check(same(allRestOrder, ['sb-band-rest']) && allRest.includes('>5 คน</span>'), 'no one reaches a cutoff: one 🍦 band for all', allRestOrder);

  const noMedals = scoreboardHtml(buildScoreboard(parseCmsRanking(fixture('cms-thai.txt')), { cutoffs: {} }));
  check(!noMedals.includes('class="sb-band') && !noMedals.includes('class="sb-row sb-rest"'), 'no cutoffs at all: no bands, no blue rows');

  const tasks = Array.from({ length: 9 }, (_, i) => `p${i}`).join(' ');
  const wide = parseCmsRanking(`Username User ${tasks} Global\nu1 N ${'1 '.repeat(9)}9\n`);
  check(scoreboardHtml(buildScoreboard(wide, { cutoffs: {} })).includes('A4 landscape'), 'nine or more problems print landscape');
}

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All ranking checks passed');
