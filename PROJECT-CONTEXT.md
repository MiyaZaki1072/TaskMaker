# Project Context

Shared baseline for AI-assisted sessions on this repository. Declarative context only —
no instructions, no credentials.

## Project

**Problem Studio** (`sovn-problem-kit`, repo `RYWCC-Task-Maker`) — a self-hosted tool for
authoring Thai olympiad (สอวน.) competitive-programming problems. Author a problem in YAML,
edit and preview it live in a browser studio, export print-ready A4 PDFs and combined booklets.
Thai typography, KaTeX maths and print layout are first-class, not bolted on. The repository is
the *tool*; problem content stays with the operator and is gitignored.

## Tech stack

TypeScript (ESM, Node >= 18) · Express 5 · Postgres (`pg`) · Zod schema validation ·
Handlebars + KaTeX + highlight.js rendering · Puppeteer/Chromium for PDF · pdf-lib for booklets ·
esbuild bundle (`build/server.js`) · tsx for all script entrypoints · Docker Compose
(studio + Postgres) · GitHub Actions CI.

Browser side is plain CSS and JavaScript served statically from `src/studio-public/` — no
frontend framework, no build step.

## Current phase

Preparing the repository to go **public on GitHub as a portfolio piece** — the audience is
recruiters and engineers reading the code, not outside contributors. Recently migrated off
Vercel to Docker-only self-hosting; an authentication bypass was found and fixed in the same
pass. A `src/` restructure is under consideration but is not a prerequisite for publishing.

## Key constraints

- **Audience is readers, not contributors.** Presentation (README, screenshots, repo metadata)
  outranks contributor scaffolding (CONTRIBUTING, issue templates, release process).
- **No test-runner framework.** Regression coverage is hand-rolled tsx scripts in `scripts/`
  plus HTML snapshot fixtures in `test/`. Any module restructure is therefore unprotected at the
  unit level; `scripts/asset-regression.ts` needs a live Postgres and does not run in CI.
- **No linter or formatter** is configured, so a formatting pass and a logic refactor must never
  share a commit.
- **Two oversized modules**: `src/studio-server.ts` (~1050 lines) and `src/storage-db.ts`
  (~780 lines) carry most of the routing and persistence logic respectively.
- **Secrets discipline**: `.env` is gitignored and has never been committed; git history was
  scanned across all commits and is clean. `.env.example` is the documented surface.
- **The studio is internet-reachable by design** (shared-password auth, signed session cookies,
  Origin checks, rate limiting), so auth and upload paths carry real risk.
- **Fonts and Chromium ship in the image** — PDF export silently renders Thai as empty boxes if
  the Thai fonts go missing, so CI asserts their presence directly.

## What "done" looks like

- The repository is public and reads well to someone skimming it for 60 seconds: README leads
  with what it is, a screenshot, and the stack; GitHub description and topics are set.
- CI stays green on `main`, and the security suite (`npm run verify:security`) remains the
  check that gates changes to auth, sessions, CSRF, uploads and rate limiting.
- Nothing sensitive is reachable in the working tree or in git history.
- If the `src/` restructure proceeds: module boundaries are decided first, a formatting-only
  commit lands separately from any logic change, and the four regression scripts — including
  the Postgres-backed asset run — are green against a recorded pre-restructure baseline.
