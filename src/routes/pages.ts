/**
 * The HTML pages: dashboard, scoreboard, library, the editor, and the live preview it embeds.
 * The page markup itself is in src/studio-pages.ts; the scripts that run in them are in
 * src/studio-public/.
 */
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { checkProblem } from '../problem-ops.js';
import { renderErrorPage, renderProblem } from '../render.js';
import { LIVE_RELOAD_CLIENT } from '../server.js';
import { ensureProblemCurrent } from '../storage-db.js';
import { dashboardPage, editorPage, libraryPage, scoreboardPage } from '../studio-pages.js';
import { paramStr, resolveFolder, resolveFolderPresent } from './shared.js';

export function pageRoutes(): Router {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.type('html').send(dashboardPage());
  });

  router.get('/scoreboard', (_req, res) => {
    res.type('html').send(scoreboardPage());
  });

  router.get('/library', (_req, res) => {
    res.type('html').send(libraryPage());
  });

  router.get('/editor/:folder', async (req, res) => {
    let dir: string;
    try {
      // One query on this problem alone, so opening it reflects the database without paying for
      // a reconcile of everything.
      await ensureProblemCurrent(paramStr(req.params.folder));
      dir = resolveFolder(paramStr(req.params.folder));
    } catch {
      res.redirect('/');
      return;
    }
    const folder = path.basename(dir);
    const content = fs.readFileSync(path.join(dir, 'problem.yaml'), 'utf8');
    const check = checkProblem(dir);
    res.type('html').send(
      editorPage({
        folder,
        code: check.code ?? folder,
        name: check.name ?? folder,
        content,
      }),
    );
  });

  router.get('/preview/:folder', async (req, res) => {
    try {
      const dir = await resolveFolderPresent(paramStr(req.params.folder));
      // No asset pre-hydration here on purpose. The filename warning that used to fire falsely on
      // a cold instance is now handled where it belongs — render.ts asks durable storage directly
      // (see assetMayExistInStorage) — so every render path is covered, not just this one, and a
      // preview costs no extra query. The images themselves stay lazy: the browser's own request
      // for each one hydrates it via the /problem-assets route (routes/assets.ts).
      const { html } = renderProblem(dir, {
        live: true,
        showWarnings: true,
        assetsBasePath: `/problem-assets/${encodeURIComponent(paramStr(req.params.folder))}`,
      });
      res.type('html').send(html);
    } catch (err) {
      res.status(200).type('html').send(renderErrorPage(err, true));
    }
  });

  router.get('/__live-reload.js', (_req, res) => {
    res.type('js').send(LIVE_RELOAD_CLIENT);
  });

  return router;
}
