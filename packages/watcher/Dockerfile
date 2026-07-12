# Multi-stage build for the combined watcher service. Build context is the repo
# root (so the file:../game-sdk dependency resolves). The full node image in the
# build stage carries the toolchain better-sqlite3 needs; the runtime is slim.

FROM node:22 AS build
WORKDIR /app

# Build the SDK first (the watcher depends on its dist).
COPY packages/game-sdk/package.json packages/game-sdk/tsconfig.json packages/game-sdk/
COPY packages/game-sdk/src packages/game-sdk/src
RUN cd packages/game-sdk && npm install && npm run build

# Build the watcher (resolves ckb-up-down-sdk via file:../game-sdk).
COPY packages/watcher/package.json packages/watcher/tsconfig.json packages/watcher/
COPY packages/watcher/src packages/watcher/src
RUN cd packages/watcher && npm install && npm run build

FROM node:22-slim AS runtime
WORKDIR /app/packages/watcher
ENV NODE_ENV=production
# Bring the built SDK + watcher (incl. node_modules with the native sqlite addon).
COPY --from=build /app/packages/game-sdk /app/packages/game-sdk
COPY --from=build /app/packages/watcher /app/packages/watcher
RUN mkdir -p /app/packages/watcher/data
EXPOSE 8080
VOLUME ["/app/packages/watcher/data"]
CMD ["node", "--enable-source-maps", "dist/bin/server.js"]
