# Contributing

Thanks for helping out. This page gets you from a fresh clone to an open pull request, and tells you
where to look when you want to change something.

## Setup

You need **Node.js 22.12 or newer** (Puppeteer, which renders the PDFs, requires it) and Git. Docker is optional — only needed to test the
self-hosted image.

```sh
git clone https://github.com/MiyaZaki1072/RYWCC-Task-Maker.git
cd RYWCC-Task-Maker
npm install
npm run studio        # opens the dashboard on http://127.0.0.1:4322
```

Local mode needs no password and no database: problems are plain files in `problems/`. Create one
from the dashboard's **+ New Problem** button, or `npm run new "Example Task"`.

> **Windows / PowerShell:** if `npm` fails with *"running scripts is disabled on this system"*,
> run it as `npm.cmd run studio`, use Git Bash, or allow scripts once for your user with
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Before you open a pull request

```sh
npm run typecheck     # TypeScript + a syntax check of the browser scripts
npm run validate      # every problem.yaml in problems/ against the schema
npm test              # every regression test, with a pass/fail summary at the end
```

All three must pass — CI runs exactly these, plus a Docker image build. The list of tests lives in
`test/run-all.ts`; add a new test file there and CI picks it up. A few tests have extra modes:

- `npm run test:text -- --update` rewrites the HTML snapshots in `test/fixtures/__snapshots__/`.
  Only do this when you *meant* to change the rendered output, and say so in the PR.
- `npm run test:assets`, and the second half of `npm run test:library`, need a throwaway Postgres —
  see the comment at the top of each file for the one-line `docker run`.

## Where things live

```text
src/                   the application
  studio-server.ts       wires the app together: middleware order, which routes mount where
  routes/                the HTTP routes, one file per feature (problems, pdf, zip, library…)
  studio-pages.ts        the HTML shell of each page
  studio-public/         browser code — plain JS and CSS, no build step
  render.ts              problem.yaml → validated model → HTML (preview and PDF share it)
  text.ts                the writing syntax: paragraphs, bold, tables, maths, images …
  …                      one file per feature — see the Layout table in README.md
config/schema.ts       the problem.yaml schema (Zod) and its error messages
templates/             render.hbs (problem layout) and the new-problem template
assets/                print CSS and bundled fonts
scripts/               command-line entry points (`npm run studio`, `pdf`, `new`, …)
test/                  regression tests (`npm test`) and their fixtures
docs/                  deployment guide and screenshots
```

### "I want to change…"

| …this | Start in | Test with |
|---|---|---|
| A field in `problem.yaml` | `config/schema.ts`, then `src/render.ts` and `templates/render.hbs`; add it to `templates/problem.template.yaml` | `npm run test:text`, `npm run validate` |
| Writing syntax (bold, tables, colours…) | `src/text.ts` | `npm run test:text` |
| How a problem looks on screen / on paper | `templates/render.hbs`, `assets/style.css` | preview in the studio; `npm run pdf problems/<dir>` |
| The dashboard page | `src/studio-public/dashboard.js`, `studio.css` | `npm run studio` |
| The editor page | `src/studio-public/editor.js`, `studio.css` | `npm run studio` |
| The library page (`global/` images, snippets) | `src/library.ts`, `src/routes/library.ts`, `src/studio-public/library.js` | `npm run test:library` |
| The scoreboard maker | `src/scoreboard.ts`, `src/routes/scoreboard.ts`, `src/studio-public/scoreboard.js` | `npm run test:ranking` |
| Creating, saving or deleting problems and their images | `src/routes/problems.ts` | `npm run test:smoke` |
| ZIP export and import | `src/routes/zip.ts` | `npm run verify:zip` |
| A new page or API endpoint | the matching file in `src/routes/`; a new feature gets a new file, mounted in `src/studio-server.ts` | add it to `test/smoke.ts` |
| Sign-in, sessions, CSRF, rate limits | `src/auth.ts`, `src/routes/auth.ts` | `npm run verify:security` |
| PDF export and booklets | `src/pdf-export.ts`, `src/booklet.ts`, `src/routes/pdf.ts` | `npm run pdf problems/<dir>`, `npm run pdf:booklet` |
| Postgres storage | `src/storage-db.ts`, `src/db.ts` | `npm run test:assets` (needs a database) |
| The Docker image | `Dockerfile`, `docker-compose.yml` | `docker compose up --build` |

When you add a browser script under `src/studio-public/`, add it to `verify:client` in
`package.json` too. When you add a file the container reads at runtime, check the `COPY` lines in
the `Dockerfile` and the file list in `.github/workflows/ci.yml` — a missing file builds fine and
only fails once deployed.

## Conventions

- **Style.** 2-space indent, LF line endings, UTF-8 — `.editorconfig` sets this up in most
  editors. Match the code around you; there is no formatter yet.
- **Errors users see** are thrown as `ProblemError` (`src/errors.ts`) with a plain-language
  message and a hint. Authors are not programmers and must never see a stack trace.
- **Comments explain why**, not what — the existing files are a good guide.
- **Commit messages** follow `type: summary`, e.g. `feat: snippet picker`, `fix: logo cache`,
  `docs: …`, `style: …`, `refactor: …`, `test: …`.

## Workflow

1. Create a branch from `main`: `git switch -c feat/short-name`.
2. Keep each pull request to one change. Moving files and changing code in the same PR makes it
   hard to review — split them.
3. Push and open a PR against `main`. Fill in the template; CI must be green before merging.

Found a bug or have an idea? Open an issue — the templates ask for what's needed. For a security
problem, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.
