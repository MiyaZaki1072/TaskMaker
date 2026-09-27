/**
 * Static files: print CSS and fonts, the studio's own browser scripts, vendored KaTeX and
 * highlight.js styles, each problem's images, and `global/…` images from the shared library.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type Router } from 'express';
import { ProblemError } from '../errors.js';
import { serveLibraryAsset } from '../library.js';
import { IMMUTABLE_ASSET, ROOT } from '../render.js';
import { ensureAssetLocal } from '../storage-db.js';
import { paramStr, resolveFolderPresent } from './shared.js';

const KATEX_DIST = path.join(ROOT, 'node_modules', 'katex', 'dist');
const HLJS_STYLES = path.join(ROOT, 'node_modules', 'highlight.js', 'styles');
// The Dockerfile copies this folder into the image by name, and CI asserts its files are there —
// keep them in step if it ever moves.
const STUDIO_PUBLIC = path.join(ROOT, 'src', 'studio-public');
const PRIVATE_REVALIDATE = {
  setHeaders: (res: http.ServerResponse) => res.setHeader('Cache-Control', 'private, no-cache'),
};

export function assetRoutes(): Router {
  const router = express.Router();

  // Mounted before /assets so the fonts match here first and get the immutable policy; the
  // shorter /assets mount below still serves style.css with ordinary revalidation.
  router.use('/assets/fonts', express.static(path.join(ROOT, 'assets', 'fonts'), IMMUTABLE_ASSET));
  // Behind the login, so kept out of shared caches (Cloudflare) and revalidated on every load. The
  // studio pages also version these URLs (see ASSET_VERSION in studio-pages.ts), which is what
  // actually defeats a CDN that overrides the header.
  router.use('/assets', express.static(path.join(ROOT, 'assets'), PRIVATE_REVALIDATE));
  router.use('/studio-assets', express.static(STUDIO_PUBLIC, PRIVATE_REVALIDATE));
  router.use('/vendor/katex', express.static(KATEX_DIST, IMMUTABLE_ASSET));
  router.use('/vendor/hljs', express.static(HLJS_STYLES, IMMUTABLE_ASSET));

  // The site icon. Served outside /studio-assets because that sits behind the sign-in gate and the
  // sign-in page needs the icon too — '/favicon.svg' is in routes/auth.ts's PUBLIC_PATHS. It is
  // the same for everyone and reveals nothing, so public caching is fine.
  router.get('/favicon.svg', (_req, res) => {
    res.sendFile('favicon.svg', { root: STUDIO_PUBLIC, headers: { 'Cache-Control': 'public, max-age=86400' } });
  });
  // Browsers ask for /favicon.ico on their own when a page has no <link rel="icon"> (and some
  // tools, bookmarks and feed readers always do). Every modern browser accepts an SVG icon.
  router.get('/favicon.ico', (_req, res) => {
    res.redirect(302, '/favicon.svg');
  });

  router.get('/problem-assets/:folder/*splat', async (req, res) => {
    const folderParam = paramStr(req.params.folder);
    try {
      const dir = await resolveFolderPresent(folderParam);
      const splat = req.params.splat as string[] | string | undefined;
      const parts = Array.isArray(splat) ? splat : splat ? [splat] : [];
      if (parts.length === 0) {
        res.status(404).end();
        return;
      }
      const assetsDir = path.join(dir, 'assets');
      const target = path.normalize(path.join(assetsDir, ...parts));
      const assetsRoot = `${path.normalize(assetsDir)}${path.sep}`;
      // Path traversal guard: reject any resolved path that escapes assets/ (e.g. via ".." segments)
      if (!target.startsWith(assetsRoot)) {
        res.status(404).end();
        return;
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (target.toLowerCase().endsWith('.svg')) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      }
      // Images are the bulk of the bytes, so they are never downloaded speculatively on a read
      // path. If this instance happens not to have one (uploaded elsewhere), fetch just that file.
      if (!fs.existsSync(target)) {
        const relative = ['assets', ...parts].join('/');
        if (!(await ensureAssetLocal(path.basename(dir), relative))) {
          // Logged because the browser only shows a broken image: a problem whose YAML points at
          // files the database never received (a partial restore, say) is otherwise invisible.
          console.warn(`[Assets] Not in the working copy or the database: ${path.basename(dir)}/${relative}`);
          res.status(404).end();
          return;
        }
      }
      // Relative to `root`, not the absolute path: `send` refuses (with a 404) any path containing a
      // dot-directory, and in the container the working copy lives under /app/.runtime. With a root
      // it only inspects the part of the path below assets/, which the guard above already bounds.
      res.sendFile(path.relative(assetsDir, target), { root: assetsDir }, (err) => {
        if (err && !res.headersSent) {
          console.warn(`[Assets] Could not send ${path.basename(dir)}/${parts.join('/')}: ${err.message}`);
          res.status(404).end();
        }
      });
    } catch (err) {
      // A bad or unknown folder name really is "not found". Anything else — the database being
      // unreachable, most likely — is an outage, and must not be passed off as a missing image.
      if (err instanceof ProblemError) {
        res.status(404).end();
        return;
      }
      console.error(`[Assets] Could not serve an image for "${folderParam}":`, err);
      res.status(503).end();
    }
  });

  // `global/…` images from the shared library (see library.ts for why this asks the database for
  // the current version on every request instead of trusting a cached file)
  router.get('/library-assets/:name', serveLibraryAsset);

  return router;
}
