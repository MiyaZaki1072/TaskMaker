/**
 * /api/scoreboard — preview, PDF and PNG of a scoreboard built from an uploaded CMS ranking.
 * The parsing and rendering are in src/scoreboard.ts.
 *
 * Built from the uploaded CMS ranking on every request and never stored, so there is no file to
 * fetch afterwards: the PDF comes straight back in the response.
 */
import express, { type RequestHandler, type Router } from 'express';
import {
  buildScoreboard,
  parseCmsRanking,
  parseCutoff,
  renderScoreboardPdf,
  renderScoreboardPng,
  scoreboardHtml,
  type Scoreboard,
} from '../scoreboard.js';
import { getBrowser, handle } from './shared.js';

function scoreboardFromBody(body: Record<string, unknown>): Scoreboard {
  const text = typeof body.ranking === 'string' ? body.ranking : '';
  const cutoffs = (body.cutoffs ?? {}) as Record<string, unknown>;
  return buildScoreboard(parseCmsRanking(text), {
    contestName: typeof body.contestName === 'string' ? body.contestName.trim() : undefined,
    authors: typeof body.authors === 'string' ? body.authors.trim() : undefined,
    cutoffs: {
      gold: parseCutoff(cutoffs.gold, 'gold'),
      silver: parseCutoff(cutoffs.silver, 'silver'),
      bronze: parseCutoff(cutoffs.bronze, 'bronze'),
    },
  });
}

/** `heavyLimiter` is shared with the other expensive routes, so they count against one budget */
export function scoreboardRoutes(heavyLimiter: RequestHandler): Router {
  const router = express.Router();

  router.post('/scoreboard/preview', handle((req, res) => {
    const scoreboard = scoreboardFromBody(req.body || {});
    const medals = { gold: 0, silver: 0, bronze: 0 };
    for (const row of scoreboard.rows) if (row.medal) medals[row.medal] += 1;
    res.json({
      html: scoreboardHtml(scoreboard),
      contestants: scoreboard.rows.length,
      problems: scoreboard.problems,
      medals,
    });
  }));

  router.post('/scoreboard/pdf', heavyLimiter, handle(async (req, res) => {
    const scoreboard = scoreboardFromBody(req.body || {});
    const bytes = await renderScoreboardPdf(scoreboard, await getBrowser());
    res.type('application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="scoreboard.pdf"');
    res.send(Buffer.from(bytes));
  }));

  // One continuous image, as tall as the table needs — never paged or scaled down to fit
  router.post('/scoreboard/png', heavyLimiter, handle(async (req, res) => {
    const scoreboard = scoreboardFromBody(req.body || {});
    const png = await renderScoreboardPng(scoreboard, await getBrowser());
    res.type('image/png');
    res.setHeader('Content-Disposition', 'attachment; filename="scoreboard.png"');
    res.send(png);
  }));

  return router;
}
