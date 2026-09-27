/**
 * /api/library — the shared library's images (referenced from problems as `global/<name>`) and
 * text snippets. The storage and usage logic is in src/library.ts; the images themselves are
 * served by /library-assets (routes/assets.ts).
 */
import express, { type Router } from 'express';
import { ProblemError } from '../errors.js';
import {
  createSnippet,
  deleteLibraryImage,
  deleteSnippet,
  libraryImageUsage,
  libraryUsage,
  listLibraryImages,
  listSnippets,
  saveLibraryImage,
  updateSnippet,
} from '../library.js';
import { acceptImageUpload, handle, paramStr } from './shared.js';

export function libraryRoutes(): Router {
  const router = express.Router();

  router.get('/library', handle(async (_req, res) => {
    const [images, snippets] = await Promise.all([listLibraryImages(), listSnippets()]);
    res.json({ images, snippets });
  }));

  // Same name as an existing image = replace it, which is how the shared logo gets updated everywhere
  router.post(
    '/library/images',
    acceptImageUpload,
    handle(async (req, res) => {
      const file = req.file;
      if (!file) {
        throw new ProblemError('No file was uploaded', { hint: 'Select an image file first, then try again' });
      }
      const image = await saveLibraryImage(file.originalname, file.buffer);
      res.status(201).json({ image });
    }),
  );

  // Every image's "used by" list at once, for the counts on the library page
  router.get('/library/usage', handle(async (_req, res) => {
    res.json({ usage: Object.fromEntries(await libraryUsage()) });
  }));

  // Asked right before a delete, so the confirmation can name every problem that would lose the image
  router.get('/library/images/:name/usage', handle(async (req, res) => {
    res.json({ folders: await libraryImageUsage(paramStr(req.params.name)) });
  }));

  router.delete('/library/images/:name', handle(async (req, res) => {
    await deleteLibraryImage(paramStr(req.params.name));
    res.json({ ok: true });
  }));

  router.post('/library/snippets', handle(async (req, res) => {
    res.status(201).json({ snippet: await createSnippet(req.body) });
  }));

  router.put('/library/snippets/:name', handle(async (req, res) => {
    res.json({ snippet: await updateSnippet(paramStr(req.params.name), req.body) });
  }));

  router.delete('/library/snippets/:name', handle(async (req, res) => {
    await deleteSnippet(paramStr(req.params.name));
    res.json({ ok: true });
  }));

  return router;
}
