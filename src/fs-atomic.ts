/**
 * Atomic file writes.
 *
 * Studio serves concurrent requests (one process handles several at once), so a plain
 * fs.writeFileSync on problem.yaml can be observed half-written by another request that is
 * reading/validating/zipping the same file at that moment — which surfaces as a bogus YAML
 * parse error. Writing to a sibling temp file and renaming makes the swap atomic: a reader
 * sees either the old file or the new one, never a torn one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Writes data to file via a temp file + rename so readers never observe a partial write */
export function writeFileAtomic(file: string, data: string | Buffer): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* the temp file is already gone, nothing to clean up */
    }
    throw err;
  }
}

/**
 * Short content fingerprint used for "did someone else change this file since I loaded it?" checks.
 * A content hash (rather than an mtime) is what we want here: it is stable across the working
 * copy being rewritten from the database, which bumps every file's mtime without changing it.
 */
export function contentVersion(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
}
