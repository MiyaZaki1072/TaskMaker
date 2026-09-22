/**
 * npm run test:assets
 *
 * Reproduces the "uploaded image disappears from the picker" bug end-to-end, against a real
 * database, by simulating exactly what a cold serverless instance looks like: the database has
 * the asset, local disk does not.
 *
 * Before the fix, this failed because GET /api/problems/:folder/assets listed straight off
 * fs.readdirSync() (see listProblemAssets in problem-ops.ts), which only reflects whatever this
 * one instance happens to have cached in /tmp. After the fix, the route asks the database
 * (listAssetsInStorage) whenever one is configured, so a file missing from local disk still shows
 * up — and export-zip hydrates missing files first (ensureAllAssetsLocal) so a ZIP downloaded from
 * a cold instance is never a silent partial backup.
 *
 * It also covers the three other paths that used to read assets straight off local disk with no
 * hydration, which is why images appeared to be "lost after a long time" once /tmp was evicted:
 * the preview render's filename warning (a false "Image file not found"), the export server that
 * Chromium loads images through while producing a PDF or booklet (silently image-less PDFs), and
 * deleting an image (a bogus "not found in this problem" that also orphaned the database row).
 * Each check re-simulates the cold instance first, because the check before it may have hydrated
 * the file back onto disk as a side effect.
 *
 * Requires a real DATABASE_URL (a disposable Neon branch is a good choice). This cannot be
 * exercised without one: the bug is a cross-instance consistency problem, and without a database
 * there is only one "instance" (this process), so there is nothing to catch.
 *
 * Creates one throwaway problem, uses it, and deletes it (cascade-deletes its assets) in a
 * `finally` block even if an assertion fails.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { isDbConfigured } from '../src/storage-db.js';
import { PROBLEMS_DIR } from '../src/render.js';
import { startServer } from '../src/server.js';
import { createStudioApp } from '../src/studio-server.js';

const PASSWORD = 'asset_regression_test_password';

async function main(): Promise<void> {
  if (!isDbConfigured()) {
    console.log('\n  Skipped: no DATABASE_URL configured.');
    console.log('  This test simulates a cold serverless instance (database has the asset, local disk');
    console.log('  does not) — without a real database there is only one "instance", so there is');
    console.log('  nothing for this test to catch. Point DATABASE_URL at a disposable branch to run it.\n');
    return;
  }

  process.env.STUDIO_PASSWORD = PASSWORD;
  const app = createStudioApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Cannot bind server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  const authHeader = { 'X-Studio-Password': PASSWORD };

  let folder: string | undefined;
  let failures = 0;

  const fail = (message: string): void => {
    failures += 1;
    console.log(`  [FAIL] ${message}`);
  };
  const pass = (message: string): void => {
    console.log(`  [pass] ${message}`);
  };

  try {
    console.log('\n  Creating a throwaway test problem\n');
    const createRes = await fetch(`${baseUrl}/api/problems`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `asset_regression_${Date.now()}` }),
    });
    if (createRes.status !== 201) throw new Error(`Could not create test problem: HTTP ${createRes.status}`);
    ({ folder } = (await createRes.json()) as { folder: string });
    console.log(`  Using folder: ${folder}`);

    console.log('\n  Uploading a test asset\n');
    const filename = 'regression-test.png';
    const pngBytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }), filename);
    const uploadRes = await fetch(`${baseUrl}/api/problems/${folder}/assets`, {
      method: 'POST',
      headers: authHeader,
      body: form,
    });
    if (uploadRes.status !== 201) throw new Error(`Upload failed: HTTP ${uploadRes.status}`);

    const localFile = path.join(PROBLEMS_DIR, folder, 'assets', filename);
    if (!fs.existsSync(localFile)) throw new Error(`Expected the uploaded file to exist locally at ${localFile}`);

    // Every read path that hydrates on a miss writes the file back to disk as a side effect, so a
    // check running after one of them is no longer looking at a cold instance. Re-arm before each.
    const simulateColdInstance = (): void => {
      if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
    };

    console.log('\n  Simulating a cold instance: deleting the file from local disk only (the database keeps it)\n');
    simulateColdInstance();

    console.log('  Checking GET /api/problems/:folder/assets\n');
    const listRes = await fetch(`${baseUrl}/api/problems/${folder}/assets`, { headers: authHeader });
    const listData = (await listRes.json()) as { assets: Array<{ name: string }> };
    if (listData.assets.some((a) => a.name === filename)) {
      pass('the picker lists the asset even though local disk does not have it');
    } else {
      fail('the picker did NOT list the asset once it was missing from local disk — the cold-instance bug is back');
    }

    console.log('\n  Checking GET /api/problems/:folder/export-zip\n');
    simulateColdInstance();
    const zipRes = await fetch(`${baseUrl}/api/problems/${folder}/export-zip`, { headers: authHeader });
    if (zipRes.status !== 200) throw new Error(`export-zip failed: HTTP ${zipRes.status}`);
    const zipBuffer = Buffer.from(await zipRes.arrayBuffer());
    const zip = new AdmZip(zipBuffer);
    const entryNames = zip.getEntries().map((e) => e.entryName);
    if (entryNames.some((name) => name.endsWith(`assets/${filename}`))) {
      pass('the exported ZIP includes the asset even though local disk did not have it');
    } else {
      fail('the exported ZIP is missing the asset — a cold instance would ship a silent partial backup');
    }

    console.log('\n  Checking the preview does not cry wolf about a filename that is perfectly fine\n');
    // render.ts's toAssetUrl() is synchronous, so it can only look at local disk — and on a cold
    // instance it used to warn "Image file not found … check the filename" about an image that was
    // safe in the database all along. Point the yaml at the uploaded image, then ask for a preview.
    const yamlRes = await fetch(`${baseUrl}/api/problems/${folder}/yaml`, { headers: authHeader });
    const { content, version } = (await yamlRes.json()) as { content: string; version: string };
    const withLogo = `${content.replace(/\s*$/, '')}\nlogo: "assets/${filename}"\n`;
    const saveRes = await fetch(`${baseUrl}/api/problems/${folder}/yaml`, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: withLogo, baseVersion: version }),
    });
    if (saveRes.status !== 200) throw new Error(`Saving the yaml failed: HTTP ${saveRes.status}`);

    simulateColdInstance();
    const previewRes = await fetch(`${baseUrl}/preview/${folder}`, { headers: authHeader });
    const previewHtml = await previewRes.text();
    // Matched on the warning's distinctive tail rather than its opening words: the message
    // interpolates the filename ('Image file "x.png" not found …'), and the quotes around it are
    // HTML-escaped by the time they reach the page, so any prefix match is fragile.
    const FILENAME_WARNING = 'uppercase/lowercase must match exactly';
    if (!previewHtml.includes(FILENAME_WARNING)) {
      pass('the preview shows no "image file not found" warning for an image only the database has');
    } else {
      fail('the preview warned about a missing image file that the database has — the false alarm is back');
    }

    // The preview is NOT where the author actually sees this warning, which is why fixing only the
    // preview left the bug in place. The editor's warning banner is fed by the save response, and
    // the dashboard shows a per-problem warningCount — both come from checkProblem() ->
    // renderProblem(), on routes that never hydrated anything. Cover them explicitly.
    console.log('\n  Checking the editor save response carries no false filename warning\n');
    simulateColdInstance();
    const resaveRes = await fetch(`${baseUrl}/api/problems/${folder}/yaml`, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: withLogo }),
    });
    const resaveData = (await resaveRes.json()) as { warnings?: string[] };
    const saveWarnings = (resaveData.warnings ?? []).filter((w) => w.includes(FILENAME_WARNING));
    if (saveWarnings.length === 0) {
      pass('saving returns no "image not found" warning, so the editor banner stays clean');
    } else {
      fail(`saving still returns a false filename warning: ${saveWarnings[0]}`);
    }

    console.log('\n  Checking the dashboard warning count for this problem\n');
    simulateColdInstance();
    const listingRes = await fetch(`${baseUrl}/api/problems`, { headers: authHeader });
    const listing = (await listingRes.json()) as { problems?: Array<{ folder: string; warningCount: number }> };
    const entry = (listing.problems ?? []).find((p) => p.folder === folder);
    if (entry && entry.warningCount === 0) {
      pass('the dashboard reports 0 warnings, so no false indicator appears on the problem card');
    } else {
      fail(`the dashboard reports warningCount=${entry ? entry.warningCount : 'missing'} — the false indicator is back`);
    }

    console.log('\n  Checking the export server Chromium loads images through (PDF and booklet)\n');
    // exportProblemPdf and buildBooklet both point Chromium at src/server.ts and let it fetch every
    // image over HTTP. That route used to be a bare express.static over local disk, so a cold
    // instance produced a PDF with the images silently missing and no error anywhere.
    simulateColdInstance();
    const exportServer = await startServer(path.join(PROBLEMS_DIR, folder));
    try {
      const imgRes = await fetch(`${exportServer.url}/problem-assets/${filename}`);
      const imgBytes = imgRes.status === 200 ? (await imgRes.arrayBuffer()).byteLength : 0;
      if (imgBytes === pngBytes.length) {
        pass('the export server serves the image from the database, so an exported PDF is not image-less');
      } else {
        fail(`the export server did not serve the image (HTTP ${imgRes.status}) — exported PDFs would lose it`);
      }
    } finally {
      await exportServer.close();
    }

    console.log('\n  Checking an image can be deleted on an instance that does not have it locally\n');
    // The database, not local disk, decides whether the image existed. This used to fail with a
    // bogus "not found in this problem" and leave the database row orphaned.
    simulateColdInstance();
    const deleteRes = await fetch(`${baseUrl}/api/problems/${folder}/assets/${filename}`, {
      method: 'DELETE',
      headers: authHeader,
    });
    if (deleteRes.status === 200) {
      pass('the delete succeeded even though the file was not on this instance\'s disk');
    } else {
      fail(`the delete failed with HTTP ${deleteRes.status} on a cold instance — the row would be orphaned`);
    }
    if (deleteRes.status !== 200) throw new Error(`Delete failed: HTTP ${deleteRes.status}`);

    console.log('\n  Checking a real delete is not undone by the read-through-from-database path\n');
    const afterDeleteRes = await fetch(`${baseUrl}/problem-assets/${folder}/assets/${filename}`, {
      headers: authHeader,
    });
    if (afterDeleteRes.status === 404) {
      pass('the deleted asset stays deleted — ensureAssetLocal does not resurrect it from a stale DB row');
    } else {
      fail(`the deleted asset was still served (HTTP ${afterDeleteRes.status}) — the delete did not fully take effect`);
    }
  } finally {
    delete process.env.STUDIO_PASSWORD;
    if (folder) {
      await fetch(`${baseUrl}/api/problems/${folder}`, { method: 'DELETE', headers: authHeader }).catch(() => undefined);
    }
    server.close();
  }

  console.log('');
  if (failures > 0) {
    console.log(`  ${failures} check(s) failed\n`);
    process.exit(1);
  }
  console.log('  All checks passed\n');
}

main().catch((err) => {
  console.error('\n Test error:', err);
  process.exit(1);
});
