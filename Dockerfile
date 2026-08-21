# Multi-stage build producing two images from one file:
#   docker build --target api    -t clickscope-api    .
#   docker build --target worker -t clickscope-worker .
#
# Both images share 100% of their dependency tree (worker/ has no
# separate package.json — see CLAUDE.md) and differ only in which tsc
# project compiles and which dist/*.js file runs. See Notes.md,
# "Phase 15a: Containerization & CI" for the full reasoning.

# ---- deps: install once, shared by both build targets ----
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---- build-api: compile src/ only (tsc -p tsconfig.json -> dist/server.js etc.) ----
FROM deps AS build-api
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- build-worker: compile worker/ + the two src/ files it imports.
# worker/tsconfig.json sets rootDir to the repo root, so this mirrors the
# whole tree into dist/ (dist/worker/index.js, dist/src/queues/contracts.js,
# dist/src/lib/sentryScrub.js) rather than the flatter layout build-api
# produces — both a full `src` copy and `worker` are required as input. ----
FROM deps AS build-worker
COPY tsconfig.json ./
COPY src ./src
COPY worker ./worker
RUN npm run worker:build

# ---- runtime-base: prod-only deps, non-root, shared by both final images.
# A second `npm ci --omit=dev` against the same lockfile (not a copy of the
# build stage's node_modules) so devDependencies like typescript, vitest,
# and tsx never end up in the shipped image. ----
FROM node:24-alpine AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# node:24-alpine already ships a non-root `node` user (uid 1000).
USER node

# ---- api: final image ----
FROM runtime-base AS api
COPY --from=build-api --chown=node:node /app/dist ./dist
# src/routes/docs.ts reads this file synchronously at import time, not
# per-request — omitting it crashes the container on startup, not just on
# a /docs request.
COPY --chown=node:node openapi.json ./openapi.json
EXPOSE 3000
CMD ["node", "dist/server.js"]

# ---- worker: final image ----
FROM runtime-base AS worker
COPY --from=build-worker --chown=node:node /app/dist ./dist
CMD ["node", "dist/worker/index.js"]
