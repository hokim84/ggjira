# syntax=docker/dockerfile:1
# GGJIRA Router image (docs/router-service-implementation-plan.md §5 "기술 구성과 기본값").
# Stages: deps (full install) → test (npm run check on Linux) / build (compile + prune) → runtime.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 falls back to a source build when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

FROM deps AS test
# git: worktree tests. procps: `ps` for the process-tree kill test.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git procps \
  && rm -rf /var/lib/apt/lists/*
COPY tsconfig.json tsconfig.build.json biome.json vitest.config.ts ./
COPY src ./src
COPY test ./test
COPY web ./web
RUN chmod +x test/fixtures/fake-workers/*.sh
CMD ["npm", "run", "check"]

FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY web ./web
RUN mkdir -p /data /config && chown node:node /data /config
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli.js"]
# --host 0.0.0.0 so Caddy reaches the Router (and the setup wizard, before a config exists).
CMD ["router", "serve", "--config", "/config/router.config.json", "--host", "0.0.0.0"]
