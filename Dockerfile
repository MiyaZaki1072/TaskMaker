# syntax=docker/dockerfile:1
#
# Problem Studio — self-hosted image for ZimaOS.
#
# Built on the ZimaOS box itself (docker compose builds it), which is why there is no fixed
# architecture here: the same Dockerfile produces an amd64 image on a ZimaBoard/mini-PC and an
# arm64 one on ARM hardware, because every base image and apt package below exists for both.
#
# Chromium comes from Debian rather than from puppeteer's own download. Puppeteer only publishes
# an x86_64 build, so letting it download would produce an image that runs on one architecture
# and fails with "Could not find Chromium" on the other.

# ---------- build ----------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Puppeteer's postinstall would otherwise pull ~150 MB of Chromium that this image never uses.
ENV PUPPETEER_SKIP_DOWNLOAD=true

# Dependencies first, in their own layer: editing source does not re-run npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY config ./config
COPY src ./src
COPY scripts ./scripts

# Bundles scripts/serve.ts and everything it imports into one build/server.js. Type-checks first,
# so a type error fails the image build instead of the container's first request.
RUN npx tsc --noEmit && npm run build:server

# ---------- runtime ----------
FROM node:22-bookworm-slim
WORKDIR /app

# chromium            - PDF export (see src/pdf-export.ts)
# fonts-thai-tlwg     - Thai glyphs. Without these, Chromium renders every Thai character in the
#                       PDF as an empty box, which is the entire content of this app.
# fonts-liberation    - Latin metric-compatible fonts, for mixed Thai/English problems
# ca-certificates     - TLS roots, so a managed Postgres over sslmode=require still verifies
# dumb-init           - PID 1 that reaps zombies and forwards SIGTERM; Chromium leaves child
#                       processes behind on every export, and node as PID 1 does not reap them
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      chromium \
      fonts-thai-tlwg \
      fonts-liberation \
      ca-certificates \
      dumb-init \
 && rm -rf /var/lib/apt/lists/*

# PROBLEMS_DIR is scratch space inside the container: Postgres holds the durable copy and
# storage-db.ts reconciles this directory against it on every boot. It is deliberately NOT a
# volume — see docker-compose.yml.
ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    HOST=0.0.0.0 \
    PORT=4322 \
    PROBLEMS_DIR=/app/.runtime/problems \
    DIST_DIR=/app/.runtime/dist \
    PROBLEMS_DIR_DISPOSABLE=1

COPY package.json package-lock.json ./
# --omit=optional skips @sparticuz/chromium (a Lambda-only Chromium build, useless here).
RUN npm ci --omit=dev --omit=optional && npm cache clean --force

# Read at runtime through ROOT-relative paths in src/render.ts
COPY templates ./templates
COPY assets ./assets
# The browser-side files (studio.css, dashboard.js, editor.js), served at /studio-assets from
# ROOT/src/studio-public by studio-server.ts. Easy to miss: esbuild bundles the *server* code into
# build/server.js, but these are never imported — the browser fetches them off disk. Without this
# the app serves its HTML fine and then 404s every stylesheet and script, so the dashboard loads
# unstyled and every button is dead.
COPY src/studio-public ./src/studio-public
# Ships empty (problems/.gitkeep): the repository is the tool, not the content. The directory
# still has to exist — it is the working copy seeded from Postgres on first boot
# (see seedWorkingCopy / initStorage).
COPY problems ./problems
COPY --from=build /app/build ./build

# Drop root: nothing here needs it, and Chromium refuses to run as root without --no-sandbox
# anyway. The node image ships this user already.
RUN mkdir -p /app/.runtime && chown -R node:node /app/.runtime
USER node

EXPOSE 4322

# Fails the container healthcheck if the studio stops answering, so `docker compose ps` and the
# ZimaOS dashboard show it as unhealthy rather than "running" while it serves errors.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4322)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "build/server.js"]
