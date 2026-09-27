/**
 * npm run test:smoke
 *
 * Boots the studio and requests every page, every stylesheet and script those pages link to, and
 * the API routes that need no browser or database — asserting each answers with the right status.
 *
 * Why this exists: a lot of this app is wired together by strings that the type-checker cannot see
 * — static mount paths, the <script>/<link> URLs in studio-pages.ts, route paths, middleware order.
 * Moving a file or splitting a router can break any of them with `tsc` still passing, and the first
 * sign would be a dashboard with dead buttons. This catches that.
 *
 * Runs against a scratch working copy, library and dist (never the repo's problems/), with no
 * password and no database — the same mode as `npm run studio`. PDF export is not exercised: it
 * needs Chromium, which CI does not download.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// render.ts reads these at import time, so they are set before the dynamic import in main()
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
process.env.PROBLEMS_DIR = path.join(SCRATCH, 'problems');
process.env.LIBRARY_DIR = path.join(SCRATCH, 'library');
process.env.DIST_DIR = path.join(SCRATCH, 'dist');
delete process.env.STUDIO_PASSWORD;
delete process.env.DATABASE_URL;

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RANKING = fs.readFileSync(path.join(FIXTURES_DIR, 'ranking', 'cms-sample.txt'), 'utf8');
// A valid 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

let failures = 0;
function check(ok: boolean, message: string): void {
  if (ok) {
    console.log(`  [pass] ${message}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${message}`);
  }
}

/** Every same-site stylesheet, script and image a page asks the browser to load */
function linkedAssets(html: string): string[] {
  const urls = new Set<string>();
  for (const match of html.matchAll(/<(?:link|script|img)\b[^>]*\b(?:href|src)="(\/[^"/][^"]*)"/g)) {
    const url = match[1]!.replace(/&amp;/g, '&');
    if (/^\/(assets|studio-assets|vendor|problem-assets|library-assets|__live|favicon)/.test(url)) urls.add(url);
  }
  return [...urls];
}

async function main(): Promise<void> {
  const { createStudioApp } = await import('../src/studio-server.js');
  const server = http.createServer(createStudioApp({ boundHost: '127.0.0.1' }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot bind server');
  const base = `http://127.0.0.1:${address.port}`;
  const get = (url: string, init?: RequestInit) => fetch(`${base}${url}`, { redirect: 'manual', ...init });
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  try {
    console.log('\nProblem fixture\n');
    const created = await get('/api/problems', json('POST', { name: 'Smoke Test' }));
    const { folder } = (await created.json()) as { folder: string };
    check(created.status === 201 && Boolean(folder), `POST /api/problems creates a problem (${created.status}, "${folder}")`);
    const f = encodeURIComponent(folder);

    console.log('\nPages, and every stylesheet and script they load\n');
    const pages = ['/', '/scoreboard', '/library', `/editor/${f}`, `/preview/${f}`];
    const assets = new Set<string>();
    for (const page of pages) {
      const res = await get(page);
      const html = await res.text();
      check(res.status === 200 && (res.headers.get('content-type') ?? '').includes('text/html'), `GET ${page} → 200 HTML`);
      for (const url of linkedAssets(html)) assets.add(url);
      // The preview is a bare problem page shown inside the editor's iframe, so it has no tab icon
      if (!page.startsWith('/preview/')) check(/<link rel="icon"[^>]*href="\/favicon\.svg/.test(html), `${page} links the site icon`);
    }
    check(assets.size >= 6, `pages link to ${assets.size} assets (expected the studio CSS, one script per page, KaTeX…)`);
    for (const url of assets) {
      const res = await get(url);
      await res.arrayBuffer();
      check(res.status === 200, `GET ${url.split('?')[0]} → 200 (${res.status})`);
    }

    console.log('\nOther routes outside /api\n');
    const expectations: Array<[string, number]> = [
      ['/healthz', 200],
      ['/favicon.ico', 302],
      ['/__live-reload.js', 200],
      ['/assets/fonts/THSarabunNew.woff2', 200],
      ['/editor/no-such-problem', 302],
      ['/no-such-page', 404],
      ['/login', 303],
    ];
    for (const [url, status] of expectations) {
      const res = await get(url);
      await res.arrayBuffer();
      check(res.status === status, `GET ${url} → ${status} (${res.status})`);
    }

    const icon = await get('/favicon.svg');
    const iconBody = await icon.text();
    check(
      icon.status === 200 && (icon.headers.get('content-type') ?? '').includes('image/svg+xml') && iconBody.includes('<svg'),
      'GET /favicon.svg → the SVG icon',
    );
    const iconRedirect = await get('/favicon.ico');
    await iconRedirect.arrayBuffer();
    check(iconRedirect.headers.get('location') === '/favicon.svg', '/favicon.ico redirects to /favicon.svg');

    console.log('\nProblem API\n');
    const list = await get('/api/problems');
    const listed = (await list.json()) as { problems: Array<{ folder: string }> };
    check(list.status === 200 && listed.problems.some((p) => p.folder === folder), 'GET /api/problems lists the fixture');

    const yaml = await get(`/api/problems/${f}/yaml`);
    const loaded = (await yaml.json()) as { content: string; version: string };
    check(yaml.status === 200 && loaded.content.includes('task:'), 'GET /api/problems/:folder/yaml → the YAML');

    const saved = await get(`/api/problems/${f}/yaml`, json('PUT', { content: loaded.content, baseVersion: loaded.version }));
    check(saved.status === 200 && ((await saved.json()) as { version?: string }).version !== undefined, 'PUT /api/problems/:folder/yaml saves');

    const upload = new FormData();
    upload.append('file', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'dot.png');
    const uploaded = await get(`/api/problems/${f}/assets`, { method: 'POST', body: upload });
    await uploaded.arrayBuffer();
    check(uploaded.status === 201, `POST /api/problems/:folder/assets uploads an image (${uploaded.status})`);
    const assetList = (await (await get(`/api/problems/${f}/assets`)).json()) as { assets: Array<{ name: string }> };
    check(assetList.assets.some((a) => a.name === 'dot.png'), 'GET /api/problems/:folder/assets lists it');
    const served = await get(`/problem-assets/${f}/dot.png`);
    check(served.status === 200 && Buffer.from(await served.arrayBuffer()).equals(PNG), 'GET /problem-assets/:folder/dot.png serves the same bytes');
    const traversal = await get(`/problem-assets/${f}/..%2Fproblem.yaml`);
    await traversal.arrayBuffer();
    check(traversal.status === 404, `path traversal out of assets/ → 404 (${traversal.status})`);
    const removed = await get(`/api/problems/${f}/assets/dot.png`, { method: 'DELETE' });
    await removed.arrayBuffer();
    check(removed.status === 200, 'DELETE /api/problems/:folder/assets/:filename');

    const noPdf = await get(`/api/problems/${f}/pdf/file`);
    const noPdfBody = (await noPdf.json()) as { error?: { message?: string; hint?: string } };
    check(noPdf.status === 400 && Boolean(noPdfBody.error?.hint), 'GET …/pdf/file before exporting → 400 with a hint');
    const noBooklet = await get('/api/booklet/file');
    await noBooklet.arrayBuffer();
    check(noBooklet.status === 400, 'GET /api/booklet/file before building → 400');

    const zip = await get(`/api/problems/${f}/export-zip`);
    check(zip.status === 200 && zip.headers.get('content-type') === 'application/zip', 'GET /api/problems/:folder/export-zip → a ZIP');
    await zip.arrayBuffer();

    console.log('\nScoreboard and library API\n');
    const board = await get('/api/scoreboard/preview', json('POST', { ranking: RANKING, contestName: 'Smoke' }));
    const boardBody = (await board.json()) as { html?: string; contestants?: number };
    check(board.status === 200 && Boolean(boardBody.html) && (boardBody.contestants ?? 0) > 0, 'POST /api/scoreboard/preview renders');
    const library = await get('/api/library');
    check(library.status === 200 && Array.isArray(((await library.json()) as { images?: unknown }).images), 'GET /api/library');
    const usage = await get('/api/library/usage');
    await usage.arrayBuffer();
    check(usage.status === 200, 'GET /api/library/usage');

    console.log('\nErrors and middleware order\n');
    const malformed = await get(`/api/problems/${f}/yaml`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    const malformedBody = (await malformed.json().catch(() => ({}))) as { error?: { message?: string } };
    check(malformed.status >= 400 && Boolean(malformedBody.error?.message), `malformed JSON → JSON error, not an HTML stack trace (${malformed.status})`);
    const bogus = await get('/api/problems/no-such-problem/yaml');
    check(bogus.status === 400 && Boolean(((await bogus.json()) as { error?: unknown }).error), 'unknown problem → 400 JSON error');
    const crossSite = await get(`/api/problems/${f}`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } });
    await crossSite.arrayBuffer();
    check(crossSite.status === 403, `cross-site DELETE is blocked → 403 (${crossSite.status})`);
    const headers = await get('/');
    await headers.arrayBuffer();
    check(headers.headers.get('x-frame-options') === 'SAMEORIGIN', 'security headers are set');

    const deleted = await get(`/api/problems/${f}`, { method: 'DELETE' });
    await deleted.arrayBuffer();
    check(deleted.status === 200, 'DELETE /api/problems/:folder removes the fixture');
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }

  console.log(failures ? `\n${failures} check(s) failed\n` : '\nAll smoke checks passed\n');
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  process.exit(1);
});
