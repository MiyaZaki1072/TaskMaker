import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createStudioApp } from '../src/studio-server.js';
import { PROBLEMS_DIR, loadProblem } from '../src/render.js';

async function runVerification() {
  console.log('--- Starting ZIP export/import & delete-problem tests ---\n');

  // 1. Set up a test server
  const app = createStudioApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Cannot bind server');
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  console.log(`[OK] Test server running at ${baseUrl}`);

  const testImportFolder = 'verify_auto_import';
  const targetDir = path.join(PROBLEMS_DIR, testImportFolder);
  const targetDirCopy = path.join(PROBLEMS_DIR, `${testImportFolder}_1`);

  // The repository deliberately ships no problems (see problems/.gitkeep), so these tests build
  // their own fixture instead of depending on content that may not be there. Written straight to
  // disk rather than through the API because this script runs without a database, which makes the
  // local working copy the source of truth.
  const fixtureFolder = 'verify_sample_problem';
  const fixtureDir = path.join(PROBLEMS_DIR, fixtureFolder);
  fs.mkdirSync(fixtureDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixtureDir, 'problem.yaml'),
    `task:
  code: FIX
  name: "Export fixture"
story: "A disposable problem created by verify:zip so the export tests have something to export"
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
author: "verify:zip"
`,
    'utf8',
  );

  try {
    // 2. Test GET /api/export-zip (export every problem combined)
    console.log('\n[Test 1] Export all problems combined (GET /api/export-zip)');
    const resExportAll = await fetch(`${baseUrl}/api/export-zip`);
    if (!resExportAll.ok) throw new Error(`Export all failed with HTTP ${resExportAll.status}`);
    const exportAllHeader = resExportAll.headers.get('content-type');
    const disposition = resExportAll.headers.get('content-disposition');
    console.log(`- Content-Type: ${exportAllHeader}`);
    console.log(`- Content-Disposition: ${disposition}`);
    if (exportAllHeader !== 'application/zip') throw new Error('Content-Type is not application/zip');

    const arrayBufferAll = await resExportAll.arrayBuffer();
    const zipAll = new AdmZip(Buffer.from(arrayBufferAll));
    const allEntries = zipAll.getEntries().map((e) => e.entryName);
    console.log(`- Number of files in the ZIP: ${allEntries.length}`);
    const hasProblemYaml = allEntries.some((e) => e.endsWith('problem.yaml'));
    if (!hasProblemYaml) throw new Error('problem.yaml not found in the exported ZIP');
    console.log('-> [PASS] Combined export is correct and complete');

    // 3. Test GET /api/problems/:folder/export-zip (export a single problem)
    // Export the fixture created above. This used to request a hardcoded folder named "test" and
    // failed with HTTP 400 on any checkout that did not happen to contain one.
    const sampleFolder = fixtureFolder;
    console.log(`\n[Test 2] Export a single problem (GET /api/problems/${sampleFolder}/export-zip)`);
    const resExportOne = await fetch(`${baseUrl}/api/problems/${sampleFolder}/export-zip`);
    if (!resExportOne.ok) throw new Error(`Export one failed with HTTP ${resExportOne.status}`);
    const arrayBufferOne = await resExportOne.arrayBuffer();
    const zipOne = new AdmZip(Buffer.from(arrayBufferOne));
    const oneEntries = zipOne.getEntries().map((e) => e.entryName);
    if (!oneEntries.some((e) => e === `${sampleFolder}/problem.yaml`)) {
      throw new Error(`${sampleFolder}/problem.yaml not found in the ZIP`);
    }
    console.log('-> [PASS] Single-problem export is correct and complete');

    // 4. Test POST /api/import-zip (first import)
    console.log('\n[Test 3] Import a problem from a ZIP file (POST /api/import-zip)');
    const testProblemYaml = `task:
  code: VFY
  name: "Auto-import test"
story: "This problem was created to test the ZIP import system"
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
author: "Test Author"
`;
    // Build a mock ZIP in memory
    const mockZip = new AdmZip();
    mockZip.addFile(`${testImportFolder}/problem.yaml`, Buffer.from(testProblemYaml, 'utf-8'));
    mockZip.addFile(`${testImportFolder}/assets/sample.txt`, Buffer.from('test asset content', 'utf-8'));
    const mockZipBuffer = mockZip.toBuffer();

    // First upload (mode: add)
    const formData1 = new FormData();
    formData1.append('file', new Blob([new Uint8Array(mockZipBuffer)], { type: 'application/zip' }), 'test-package.zip');
    formData1.append('mode', 'add');

    const resImport1 = await fetch(`${baseUrl}/api/import-zip`, {
      method: 'POST',
      body: formData1,
    });
    const importData1 = (await resImport1.json()) as { ok: boolean; count: number; imported: string[] };
    console.log(`- Result of import 1:`, importData1);
    if (!resImport1.ok || !importData1.ok || importData1.imported[0] !== testImportFolder) {
      throw new Error(`Import 1 failed: ${JSON.stringify(importData1)}`);
    }

    const loaded1 = loadProblem(targetDir);
    console.log(`- Problem loaded successfully: [${loaded1.task.code}] ${loaded1.task.name}`);
    console.log('-> [PASS] First import succeeded');

    // 5. Test re-importing in 'add' mode (must add a new entry, e.g. verify_auto_import_1, not overwrite!)
    console.log('\n[Test 4] Re-import in "add" mode — must add as a new entry instead of overwriting');
    const formData2 = new FormData();
    formData2.append('file', new Blob([new Uint8Array(mockZipBuffer)], { type: 'application/zip' }), 'test-package.zip');
    formData2.append('mode', 'add');

    const resImport2 = await fetch(`${baseUrl}/api/import-zip`, {
      method: 'POST',
      body: formData2,
    });
    const importData2 = (await resImport2.json()) as { ok: boolean; count: number; imported: string[] };
    console.log(`- Result of import 2 (mode=add):`, importData2);
    if (!resImport2.ok || !importData2.ok || importData2.imported[0] !== `${testImportFolder}_1`) {
      throw new Error(`Import 2 should have created ${testImportFolder}_1 but got ${JSON.stringify(importData2)}`);
    }
    if (!fs.existsSync(targetDirCopy)) {
      throw new Error(`New entry folder ${targetDirCopy} not found`);
    }
    console.log(`- The original entry (${testImportFolder}) is still there, and a new one was added (${testImportFolder}_1)`);
    console.log('-> [PASS] Imported as a new entry without overwriting the original — 100% correct');

    // 6. Test DELETE /api/problems/:folder (delete a problem)
    console.log('\n[Test 5] Delete a problem (DELETE /api/problems/:folder)');
    const resDelete = await fetch(`${baseUrl}/api/problems/${testImportFolder}_1`, {
      method: 'DELETE',
    });
    const deleteData = (await resDelete.json()) as { ok: boolean; folder: string };
    console.log(`- Delete result:`, deleteData);
    if (!resDelete.ok || !deleteData.ok || fs.existsSync(targetDirCopy)) {
      throw new Error('Delete failed, or the folder still exists');
    }
    console.log('-> [PASS] Problem and all its files were deleted successfully');

    // 7. Test error handling: a ZIP file with no problem.yaml
    console.log('\n[Test 6] Import a ZIP with no problem.yaml (error handling)');
    const badZip = new AdmZip();
    badZip.addFile('random_folder/something.txt', Buffer.from('hello', 'utf-8'));
    const badFormData = new FormData();
    badFormData.append('file', new Blob([new Uint8Array(badZip.toBuffer())], { type: 'application/zip' }), 'bad.zip');

    const resBad = await fetch(`${baseUrl}/api/import-zip`, {
      method: 'POST',
      body: badFormData,
    });
    const badData = (await resBad.json()) as { error?: { message: string } };
    console.log(`- Status: ${resBad.status}, Response message:`, badData.error?.message);
    if (resBad.status === 400 && badData.error) {
      console.log('-> [PASS] The system rejected the invalid file with a clear error message');
    } else {
      throw new Error('The system did not return HTTP 400 for an invalid file');
    }

    console.log('\n======================================================');
    console.log('  🎉 Summary: all 6/6 tests passed!');
    console.log('======================================================\n');
  } finally {
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true, force: true });
    }
    if (fs.existsSync(targetDirCopy)) {
      fs.rmSync(targetDirCopy, { recursive: true, force: true });
    }
    try {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      /* already gone */
    }
    server.close();
  }
}

runVerification().catch((err) => {
  console.error('\n❌ Test error:', err);
  process.exit(1);
});
