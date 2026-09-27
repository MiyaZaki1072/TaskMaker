/**
 * npm run test:library
 *
 * The global library (src/library.ts): shared images referenced live as `global/<name>`, and text
 * snippets. Runs against a scratch working copy and library, so nothing in the repository is
 * touched.
 *
 * Part 1 — local files (always runs; any DATABASE_URL is ignored for this part):
 *   render mapping and warnings, upload / replace / delete, filename and SVG safety, path
 *   traversal, the "used by" scan, ZIP export flattening `global/…` into the problem's own
 *   assets/, and snippet create / rename / delete.
 *
 * Part 2 — database (only with DATABASE_URL pointing at a disposable database):
 *   the cross-instance guarantees the library exists for. "Another instance" is simulated by
 *   changing the database row directly, which leaves this instance's cache exactly as stale as a
 *   second container's would be:
 *     - replaced elsewhere -> this instance serves the new bytes, not its cached copy
 *     - deleted elsewhere  -> 404 and a render warning, even with the old file still cached
 *     - a cold PDF server (empty cache) still gets the image
 *
 *   docker run --rm -d -p 5433:5432 -e POSTGRES_PASSWORD=test postgres:16
 *   DATABASE_URL=postgres://postgres:test@localhost:5433/postgres npm run test:library
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Everything below reads these at import time, so they are set before the dynamic imports in main()
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'library-regression-'));
process.env.PROBLEMS_DIR = path.join(SCRATCH, 'problems');
process.env.LIBRARY_DIR = path.join(SCRATCH, 'library');
process.env.DIST_DIR = path.join(SCRATCH, 'dist');
const PASSWORD = 'library_regression_test_password';
process.env.STUDIO_PASSWORD = PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;

// Two different images, so "which version was served" is a byte comparison. PNG decoders ignore
// data after the end chunk, so B is still a valid 1×1 PNG.
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const PNG_B = Buffer.concat([PNG_A, Buffer.from([0])]);

let failures = 0;
function check(ok: boolean, message: string): void {
  if (ok) {
    console.log(`  [pass] ${message}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${message}`);
  }
}

function fixtureYaml(logo: string, storyExtra = ''): string {
  return `task:
  code: LIB
  name: "Library fixture"
logo: "${logo}"
story: |
  A disposable problem created by test:library.
${storyExtra
  .split('\n')
  .filter(Boolean)
  .map((line) => `  ${line}`)
  .join('\n')}
input_format:
  - "An integer n"
output_format:
  - "The result"
constraints:
  - "1 <= n <= 100"
subtasks: []
examples:
  - input: "10"
    output: "20"
limits:
  time: "1.0s"
  memory: "256MB"
author: "test:library"
`;
}

async function main(): Promise<void> {
  const { createStudioApp } = await import('../src/studio-server.js');
  const { renderProblem, PROBLEMS_DIR, LIBRARY_DIR } = await import('../src/render.js');

  const app = createStudioApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Cannot bind server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const auth = { 'X-Studio-Password': PASSWORD };

  const get = (url: string) => fetch(`${baseUrl}${url}`, { headers: auth });
  const sendJson = (url: string, method: string, body: unknown) =>
    fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const del = (url: string) => fetch(`${baseUrl}${url}`, { method: 'DELETE', headers: auth });
  const upload = (filename: string, bytes: Buffer, type = 'image/png') => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)], { type }), filename);
    return fetch(`${baseUrl}/api/library/images`, { method: 'POST', headers: auth, body: form });
  };
  const bytesOf = async (res: Response) => Buffer.from(await res.arrayBuffer());

  // The fixture problem: uses the library logo, a library image that does not exist, and an
  // ordinary problem image that merely lives in a folder called "global"
  const folder = 'lib_fixture';
  const fixtureDir = path.join(PROBLEMS_DIR, folder);
  fs.mkdirSync(path.join(fixtureDir, 'assets', 'global'), { recursive: true });
  const fixtureContent = fixtureYaml(
    'global/logo.png',
    '[img: global/missing.png]\n[img: assets/global/local.png]',
  );
  fs.writeFileSync(path.join(fixtureDir, 'problem.yaml'), fixtureContent, 'utf8');
  fs.writeFileSync(path.join(fixtureDir, 'assets', 'global', 'local.png'), PNG_A);
  // Already taken, so the export has to pick global-logo-2.png instead of overwriting this
  fs.writeFileSync(path.join(fixtureDir, 'assets', 'global-logo.png'), PNG_A);
  const render = () => renderProblem(fixtureDir, { assetsBasePath: `/problem-assets/${folder}` });

  try {
    // ================= Part 1: local files =================
    console.log('\n[Part 1] Local files (no database)\n');

    let res = await upload('logo.png', PNG_A);
    check(res.status === 201, 'uploading logo.png to the library succeeds');

    let result = render();
    // Handlebars writes "=" in {{logoUrl}} as &#x3D; — the browser decodes it back in the attribute
    const decoded = (html: string) => html.replace(/&#x3D;/g, '=');
    check(
      /\/library-assets\/logo\.png\?v=\d+/.test(decoded(result.html)),
      'logo: "global/logo.png" renders as /library-assets/logo.png?v=…',
    );
    check(!result.warnings.some((w) => w.includes('global/logo.png')), 'no "not found" warning for a library image that exists');
    check(result.warnings.some((w) => w.includes('global/missing.png')), 'a missing library image gets a warning');
    check(
      result.html.includes(`/problem-assets/${folder}/global/local.png`) && !result.html.includes('/library-assets/local.png'),
      'assets/global/local.png stays an ordinary problem image',
    );
    check(
      result.warnings.some((w) => w.includes('global/missing.png') && !w.includes('did you mean')),
      'a missing image with no near match gets no "did you mean"',
    );

    // A second problem that gets the case wrong
    const caseFolder = 'lib_case_fixture';
    const caseDir = path.join(PROBLEMS_DIR, caseFolder);
    fs.mkdirSync(path.join(caseDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(caseDir, 'problem.yaml'), fixtureYaml('global/LOGO.png'), 'utf8');
    const caseWarnings = renderProblem(caseDir, { assetsBasePath: `/problem-assets/${caseFolder}` }).warnings;
    check(
      caseWarnings.some((w) => w.includes('global/LOGO.png') && w.includes('did you mean global/logo.png?')),
      'a reference that differs only by case suggests the real name',
    );
    res = await get('/library-assets/LOGO.png');
    check(res.status === 404, 'a wrong-case name is a 404 here too, as it is with a database or on Linux');
    fs.rmSync(caseDir, { recursive: true, force: true });

    res = await get('/library-assets/logo.png');
    check(res.status === 200 && (await bytesOf(res)).equals(PNG_A), 'GET /library-assets/logo.png serves the uploaded bytes');
    check(
      (res.headers.get('cache-control') ?? '').includes('no-cache') && res.headers.get('x-content-type-options') === 'nosniff',
      'library images are served no-cache + nosniff',
    );

    res = await upload('logo.png', PNG_B);
    check(res.status === 201, 're-uploading logo.png (replace) succeeds');
    res = await get('/library-assets/logo.png');
    check((await bytesOf(res)).equals(PNG_B), 'after a replace, the new bytes are served');
    const list = (await (await get('/api/library')).json()) as { images: Array<{ name: string }> };
    check(list.images.filter((i) => i.name === 'logo.png').length === 1, 'a replace keeps a single logo.png entry');

    res = await upload('bad name.png', PNG_A);
    check(res.status === 400, 'a filename with a space is rejected');
    res = await upload('script.exe', PNG_A, 'application/octet-stream');
    check(res.status === 400, 'a non-image extension is rejected');

    const evilSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><rect width="1" height="1"/></svg>',
    );
    res = await upload('icon.svg', evilSvg, 'image/svg+xml');
    check(res.status === 201, 'an SVG upload succeeds');
    res = await get('/library-assets/icon.svg');
    const svgText = (await bytesOf(res)).toString('utf8');
    check(!svgText.includes('<script') && !svgText.includes('onload'), 'scripts and event handlers are stripped from library SVGs');
    check((res.headers.get('content-security-policy') ?? '').includes('sandbox'), 'library SVGs are served with a sandbox CSP');

    res = await get('/library-assets/..%2Flogo.png');
    check(res.status === 404, 'a path-traversal name is a 404');
    res = await get('/library-assets/nope.png');
    check(res.status === 404, 'an unknown library image is a 404');

    res = await get('/api/library/images/logo.png/usage');
    const usage = (await res.json()) as { folders: string[] };
    check(usage.folders.includes(folder), 'the usage check lists the problem that uses global/logo.png');
    res = await get('/api/library/images/icon.svg/usage');
    check(((await res.json()) as { folders: string[] }).folders.length === 0, 'an unused image reports no problems');
    res = await get('/api/library/usage');
    const allUsage = ((await res.json()) as { usage: Record<string, string[]> }).usage;
    check(
      res.status === 200 && allUsage['logo.png']?.includes(folder) === true && !('icon.svg' in allUsage),
      'the all-images usage map lists logo.png as used by the fixture, and leaves unused icon.svg out',
    );

    res = await get(`/api/problems/${folder}/export-zip`);
    check(res.status === 200, 'single-problem ZIP export succeeds');
    const zip = new AdmZip(await bytesOf(res));
    const entries = zip.getEntries().map((e) => e.entryName);
    const flattened = zip.getEntry(`${folder}/assets/global-logo-2.png`);
    check(!!flattened && flattened.getData().equals(PNG_B), 'the ZIP carries the current library logo as assets/global-logo-2.png');
    check(
      zip.getEntry(`${folder}/assets/global-logo.png`)?.getData().equals(PNG_A) === true,
      "the problem's own global-logo.png is not overwritten in the ZIP",
    );
    check(entries.filter((e) => e.endsWith('problem.yaml')).length === 1, 'the ZIP has exactly one problem.yaml');
    const zippedYaml = zip.getEntry(`${folder}/problem.yaml`)?.getData().toString('utf8') ?? '';
    check(
      zippedYaml.includes('logo: "assets/global-logo-2.png"') && !zippedYaml.includes('"global/logo.png"'),
      'the exported problem.yaml points at the bundled copy',
    );
    check(
      zippedYaml.includes('global/missing.png') && zippedYaml.includes('assets/global/local.png'),
      'references with nothing to bundle, and ordinary problem images, are left alone',
    );
    check(
      fs.readFileSync(path.join(fixtureDir, 'problem.yaml'), 'utf8') === fixtureContent,
      "the studio's own problem.yaml keeps its live global/ link",
    );

    res = await del('/api/library/images/logo.png');
    check(res.status === 200, 'deleting logo.png succeeds');
    res = await get('/library-assets/logo.png');
    check(res.status === 404, 'a deleted library image is a 404');
    res = await del('/api/library/images/logo.png');
    check(res.status === 400, 'deleting it again reports it is not in the library');
    check(render().warnings.some((w) => w.includes('global/logo.png')), 'a problem using a deleted library image gets a warning');

    console.log('');
    res = await sendJson('/api/library/snippets', 'POST', { name: 'Rules', body: '1. No AI tools\n2. Three hours' });
    check(res.status === 201, 'creating a snippet succeeds');
    res = await sendJson('/api/library/snippets', 'POST', { name: 'Rules', body: 'again' });
    check(res.status === 400 && JSON.stringify(await res.json()).includes('already exists'), 'a duplicate snippet name is rejected');
    res = await sendJson('/api/library/snippets', 'POST', { name: '  ', body: 'x' });
    check(res.status === 400, 'a snippet without a name is rejected');
    res = await sendJson('/api/library/snippets', 'POST', { name: 'Empty', body: '   ' });
    check(res.status === 400, 'an empty snippet is rejected');
    res = await sendJson('/api/library/snippets/Rules', 'PUT', { name: 'Contest rules', body: '1. No AI tools' });
    check(res.status === 200, 'renaming and editing a snippet succeeds');
    res = await sendJson('/api/library/snippets/Rules', 'PUT', { name: 'Rules', body: 'x' });
    check(res.status === 400, 'editing a snippet by its old name reports it is gone');
    const thaiName = 'กติกาการแข่งขัน';
    res = await sendJson('/api/library/snippets', 'POST', { name: thaiName, body: 'ห้ามใช้ AI ทุกรูปแบบ' });
    check(res.status === 201, 'a snippet with a Thai name can be created');
    let snippets = ((await (await get('/api/library')).json()) as { snippets: Array<{ name: string; body: string }> })
      .snippets;
    check(
      snippets.length === 2 && snippets.some((s) => s.name === 'Contest rules' && s.body === '1. No AI tools'),
      'the snippet list shows the renamed snippet with its new text',
    );
    res = await del(`/api/library/snippets/${encodeURIComponent(thaiName)}`);
    check(res.status === 200, 'a snippet with a Thai name can be deleted by URL');
    res = await del('/api/library/snippets/Contest%20rules');
    check(res.status === 200, 'deleting a snippet succeeds');
    snippets = ((await (await get('/api/library')).json()) as { snippets: Array<{ name: string; body: string }> }).snippets;
    check(snippets.length === 0, 'all snippets are gone');

    await runBackupPart({ upload, get, sendJson, del, bytesOf, folder, fixtureContent, PROBLEMS_DIR, auth, baseUrl });

    res = await get('/library');
    check(res.status === 200 && (await res.text()).includes('/studio-assets/library.js'), 'the /library page is served');

    // ================= Part 2: database =================
    if (!DATABASE_URL) {
      console.log('\n[Part 2] Skipped: no DATABASE_URL configured.');
      console.log('  The cross-instance checks need a real (disposable) database — see the header of this file.\n');
    } else {
      process.env.DATABASE_URL = DATABASE_URL;
      await runDatabasePart({ upload, get, sendJson, del, bytesOf, render: renderProblem, LIBRARY_DIR, PROBLEMS_DIR });
    }
  } finally {
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    if (process.env.DATABASE_URL) {
      const { closePool } = await import('../src/db.js');
      await closePool();
    }
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAll library checks passed\n' : `\n${failures} library check(s) FAILED\n`);
  if (failures > 0) process.exitCode = 1;
}

interface BackupPartDeps {
  upload: (filename: string, bytes: Buffer, type?: string) => Promise<Response>;
  get: (url: string) => Promise<Response>;
  sendJson: (url: string, method: string, body: unknown) => Promise<Response>;
  del: (url: string) => Promise<Response>;
  bytesOf: (res: Response) => Promise<Buffer>;
  /** The fixture problem and its original problem.yaml (live global/logo.png link) */
  folder: string;
  fixtureContent: string;
  PROBLEMS_DIR: string;
  auth: Record<string, string>;
  baseUrl: string;
}

interface LibraryReport {
  added: string[];
  replaced: string[];
  skipped: string[];
  failed: string[];
}

/** Export All carries the library and keeps live links; Import restores it, honouring the mode */
async function runBackupPart(deps: BackupPartDeps): Promise<void> {
  const { upload, get, sendJson, del, bytesOf, folder, fixtureContent, PROBLEMS_DIR, auth, baseUrl } = deps;
  const importZip = async (zip: AdmZip, mode: 'add' | 'overwrite') => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(zip.toBuffer())], { type: 'application/zip' }), 'backup.zip');
    form.append('mode', mode);
    const res = await fetch(`${baseUrl}/api/import-zip`, { method: 'POST', headers: auth, body: form });
    const body = (await res.json()) as { imported?: string[]; library?: LibraryReport; error?: { message: string } };
    return { status: res.status, ...body };
  };
  const imported: string[] = [];

  console.log('\n  Export All / Import\n');
  try {
    await upload('logo.png', PNG_B);
    await sendJson('/api/library/snippets', 'POST', { name: 'Rules', body: 'ห้ามใช้ AI\nสามชั่วโมง' });

    let res = await get('/api/export-zip');
    check(res.status === 200, 'Export All succeeds');
    const backup = new AdmZip(await bytesOf(res));
    check(backup.getEntry('_library/images/logo.png')?.getData().equals(PNG_B) === true, 'Export All carries the library image under _library/images/');
    const zippedSnippets = JSON.parse(backup.getEntry('_library/snippets.json')?.getData().toString('utf8') ?? '[]') as unknown[];
    check(
      JSON.stringify(zippedSnippets) === JSON.stringify([{ name: 'Rules', body: 'ห้ามใช้ AI\nสามชั่วโมง' }]),
      'Export All carries the snippets (Thai text intact) in _library/snippets.json',
    );
    check(
      backup.getEntry(`${folder}/problem.yaml`)?.getData().toString('utf8') === fixtureContent,
      "Export All keeps the problem's live global/ link instead of flattening it",
    );
    check(!backup.getEntry(`${folder}/assets/global-logo-2.png`), 'Export All adds no flattened global- copies');

    // Lose the library, then restore it from the backup
    await del('/api/library/images/logo.png');
    await del('/api/library/snippets/Rules');
    let result = await importZip(backup, 'add');
    imported.push(...(result.imported ?? []));
    check(result.status === 200, 'importing the Export All ZIP succeeds');
    check(
      result.library?.added.includes('global/logo.png') === true && result.library.added.includes('snippet "Rules"'),
      'the import reports the library image and snippet as added',
    );
    res = await get('/library-assets/logo.png');
    check(res.status === 200 && (await bytesOf(res)).equals(PNG_B), 'the restored library image is served');
    const restored = ((await (await get('/api/library')).json()) as { snippets: Array<{ name: string; body: string }> }).snippets;
    check(restored.some((s) => s.name === 'Rules' && s.body === 'ห้ามใช้ AI\nสามชั่วโมง'), 'the restored snippet has its text');
    const copy = (result.imported ?? []).find((name) => name !== folder && name.startsWith(folder));
    check(
      !!copy && fs.readFileSync(path.join(PROBLEMS_DIR, copy, 'problem.yaml'), 'utf8').includes('logo: "global/logo.png"'),
      'the imported problem still links global/logo.png live',
    );

    // 'add' never touches what is already here
    await upload('logo.png', PNG_A);
    await sendJson('/api/library/snippets/Rules', 'PUT', { name: 'Rules', body: 'edited here' });
    result = await importZip(backup, 'add');
    imported.push(...(result.imported ?? []));
    check(
      result.library?.skipped.includes('global/logo.png') === true && result.library.skipped.includes('snippet "Rules"'),
      "'add' mode reports same-named library items as skipped",
    );
    res = await get('/library-assets/logo.png');
    check((await bytesOf(res)).equals(PNG_A), "'add' mode keeps this studio's own logo.png");

    // 'overwrite' replaces them
    result = await importZip(backup, 'overwrite');
    check(
      result.library?.replaced.includes('global/logo.png') === true && result.library.replaced.includes('snippet "Rules"'),
      "'overwrite' mode reports same-named library items as replaced",
    );
    res = await get('/library-assets/logo.png');
    check((await bytesOf(res)).equals(PNG_B), "'overwrite' mode puts the backup's logo.png back");
    const overwritten = ((await (await get('/api/library')).json()) as { snippets: Array<{ name: string; body: string }> }).snippets;
    check(overwritten.some((s) => s.name === 'Rules' && s.body === 'ห้ามใช้ AI\nสามชั่วโมง'), "'overwrite' mode puts the backup's snippet text back");

    // A library-only ZIP, with the kinds of entries an attacker would try
    const hostile = new AdmZip();
    hostile.addFile('_library/images/ok.png', PNG_A);
    hostile.addFile('_library/images/bad name.png', PNG_A);
    hostile.addFile('_library/images/run.exe', PNG_A);
    hostile.addFile(
      '_library/images/evil.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>'),
    );
    hostile.addFile('_library/snippets.json', Buffer.from(JSON.stringify([{ name: 'Good', body: 'fine' }, { name: '', body: 'x' }, 'junk'])));
    result = await importZip(hostile, 'add');
    check(result.status === 200 && (result.imported ?? []).length === 0, 'a ZIP with only a _library/ folder imports without needing a problem');
    check(result.library?.added.includes('global/ok.png') === true, 'a valid image in it is added');
    check(
      (result.library?.failed ?? []).some((f) => f.includes('bad name.png')) && (result.library?.failed ?? []).some((f) => f.includes('run.exe')),
      'bad image names and non-image files are reported, not imported',
    );
    check(result.library?.added.includes('snippet "Good"') === true, 'a valid snippet in it is added');
    check((result.library?.failed ?? []).filter((f) => f.startsWith('snippet')).length === 2, 'invalid snippets are reported, not imported');
    res = await get('/library-assets/evil.svg');
    const evil = (await bytesOf(res)).toString('utf8');
    check(res.status === 200 && !evil.includes('<script') && !evil.includes('onload'), 'an imported SVG is sanitized like an uploaded one');

    const empty = new AdmZip();
    empty.addFile('notes/readme.txt', Buffer.from('hello'));
    result = await importZip(empty, 'add');
    check(result.status === 400, 'a ZIP with neither problems nor a library is still rejected');
  } finally {
    for (const name of imported) fs.rmSync(path.join(PROBLEMS_DIR, name), { recursive: true, force: true });
    for (const name of ['logo.png', 'ok.png', 'evil.svg']) await del(`/api/library/images/${name}`);
    for (const name of ['Rules', 'Good']) await del(`/api/library/snippets/${name}`);
  }
}

interface DbPartDeps {
  upload: (filename: string, bytes: Buffer, type?: string) => Promise<Response>;
  get: (url: string) => Promise<Response>;
  sendJson: (url: string, method: string, body: unknown) => Promise<Response>;
  del: (url: string) => Promise<Response>;
  bytesOf: (res: Response) => Promise<Buffer>;
  render: typeof import('../src/render.js').renderProblem;
  LIBRARY_DIR: string;
  PROBLEMS_DIR: string;
}

async function runDatabasePart(deps: DbPartDeps): Promise<void> {
  const { upload, get, sendJson, del, bytesOf, render, LIBRARY_DIR, PROBLEMS_DIR } = deps;
  const { sql } = await import('../src/db.js');
  const { contentVersion } = await import('../src/fs-atomic.js');
  const { syncFromStorage } = await import('../src/storage-db.js');
  const { startServer } = await import('../src/server.js');

  console.log('\n[Part 2] Database\n');
  const name = `regression-${Date.now()}.png`;
  const snippetName = `regression snippet ${Date.now()}`;
  const cacheDir = path.join(LIBRARY_DIR, 'cache');

  const folder = 'lib_db_fixture';
  const fixtureDir = path.join(PROBLEMS_DIR, folder);
  fs.mkdirSync(path.join(fixtureDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(fixtureDir, 'problem.yaml'), fixtureYaml(`global/${name}`), 'utf8');
  const renderFixture = () => render(fixtureDir, { assetsBasePath: `/problem-assets/${folder}` });

  try {
    let res = await upload(name, PNG_A);
    check(res.status === 201, 'uploading to the database-backed library succeeds');
    res = await get(`/library-assets/${name}`);
    check((await bytesOf(res)).equals(PNG_A), 'the uploaded image is served');

    // Another instance replaces the image. This instance's cache still holds the old version.
    const hashB = contentVersion(PNG_B);
    await sql()`
      UPDATE library_images SET data = ${PNG_B.toString('base64')}, hash = ${hashB}, size = ${PNG_B.length}, updated_at = now()
      WHERE filename = ${name}
    `;
    res = await get(`/library-assets/${name}`);
    check((await bytesOf(res)).equals(PNG_B), 'replaced on another instance -> this instance serves the NEW bytes, not its cached copy');

    await syncFromStorage({ force: true });
    let result = renderFixture();
    check(
      result.html.replace(/&#x3D;/g, '=').includes(`?v=${hashB}`),
      'after a sync, rendered pages carry the new version in the image URL',
    );
    check(!result.warnings.some((w) => w.includes(name)), 'no false "not found" warning for an image the database has');

    // A cold PDF server: nothing cached on this instance at all
    fs.rmSync(cacheDir, { recursive: true, force: true });
    const pdfServer = await startServer(fixtureDir, { port: 0, live: false, showWarnings: false });
    try {
      const pdfRes = await fetch(`${pdfServer.url}/library-assets/${name}`);
      check(
        pdfRes.status === 200 && (await bytesOf(pdfRes)).equals(PNG_B),
        'a cold PDF/booklet render server fetches the library image from the database',
      );
    } finally {
      await pdfServer.close();
    }

    // Another instance deletes the image. This instance still has a cached copy on disk.
    await sql()`DELETE FROM library_images WHERE filename = ${name}`;
    const stillCached = fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).some((f) => f.endsWith(`-${name}`));
    check(stillCached, "(setup) the deleted image is still in this instance's cache");
    res = await get(`/library-assets/${name}`);
    check(res.status === 404, 'deleted on another instance -> 404 here, despite the cached copy');
    await syncFromStorage({ force: true });
    result = renderFixture();
    check(result.warnings.some((w) => w.includes(name)), 'deleted on another instance -> the render warns after a sync');

    res = await sendJson('/api/library/snippets', 'POST', { name: snippetName, body: 'database snippet' });
    check(res.status === 201, 'creating a snippet in the database succeeds');
    res = await sendJson('/api/library/snippets', 'POST', { name: snippetName, body: 'again' });
    check(res.status === 400, 'the database rejects a duplicate snippet name');
    res = await sendJson(`/api/library/snippets/${encodeURIComponent(snippetName)}`, 'PUT', {
      name: `${snippetName} renamed`,
      body: 'renamed',
    });
    check(res.status === 200, 'renaming a snippet in the database succeeds');
    res = await del(`/api/library/snippets/${encodeURIComponent(`${snippetName} renamed`)}`);
    check(res.status === 200, 'deleting a snippet from the database succeeds');
  } finally {
    await sql()`DELETE FROM library_images WHERE filename = ${name}`.catch(() => undefined);
    await sql()`DELETE FROM library_snippets WHERE name LIKE ${`${snippetName}%`}`.catch(() => undefined);
  }
}

main().catch((err) => {
  console.error('\nlibrary-regression crashed:', err);
  process.exitCode = 1;
});
