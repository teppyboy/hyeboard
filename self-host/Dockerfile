# Builds a self-contained image that runs Hyeboard on standalone workerd
# instead of Cloudflare's managed Workers platform.
#
# Build from the REPO ROOT (not this directory), since it needs the full
# pnpm workspace:
#   docker build -f self-host/Dockerfile -t hyeboard-workerd .

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hyeboard/web build
RUN pnpm --filter @hyeboard/worker build:workerd

FROM node:22-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /repo/apps/worker/dist-workerd/index.js ./worker.js
COPY --from=build /repo/apps/web/dist ./web-dist
COPY self-host/config.capnp ./config.capnp
COPY self-host/gateway.js ./gateway.js

EXPOSE 8080
# `npx workerd` uses the prebuilt binary published to npm - no need to build
# workerd from source (Bazel/Clang toolchain) for this deployment path.
CMD ["npx", "workerd", "serve", "config.capnp"]
