# syntax=docker/dockerfile:1.7

FROM node:22.22.0-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/automation-worker/package.json apps/automation-worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/automation-protocol/package.json packages/automation-protocol/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/schemas/package.json packages/schemas/package.json
COPY packages/university-adapters/package.json packages/university-adapters/package.json
RUN --mount=type=cache,id=hyeboard-pnpm-store,target=/pnpm/store \
  pnpm config set store-dir /pnpm/store \
  && pnpm install --frozen-lockfile --ignore-scripts

COPY . .
RUN pnpm --filter @hyeboard/automation-worker build

# pnpm deploy creates a standalone, lockfile-resolved production tree.
RUN pnpm pm deploy --filter=@hyeboard/automation-worker --prod --legacy runtime \
  && rm -rf runtime/dist runtime/src runtime/Dockerfile runtime/README.md runtime/tsconfig*.json \
  && mkdir -p runtime/dist \
  && cp apps/automation-worker/dist/cli.cjs runtime/dist/cli.cjs

FROM node:22.22.0-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /workspace/runtime/ ./
RUN apt-get update \
  && apt-get upgrade -y \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
  && groupadd --system --gid 10001 hyeboard \
  && useradd --system --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent hyeboard
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
ENTRYPOINT ["node", "dist/cli.cjs"]
