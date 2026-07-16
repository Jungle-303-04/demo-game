FROM node:22-trixie-slim AS build
WORKDIR /app/upstream-survev
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.8.0
COPY upstream-survev/package.json upstream-survev/pnpm-lock.yaml upstream-survev/pnpm-workspace.yaml ./
COPY upstream-survev/client/package.json client/package.json
COPY upstream-survev/server/package.json server/package.json
COPY upstream-survev/shared/package.json shared/package.json
COPY upstream-survev/bot/package.json bot/package.json
COPY upstream-survev/tests/package.json tests/package.json
RUN pnpm install --frozen-lockfile
COPY upstream-survev/ ./
COPY services/game-server/survev-config.hjson ./survev-config.hjson
RUN pnpm --filter @survev/server build && pnpm --filter @survev/client build

FROM node:22-trixie-slim
WORKDIR /app/upstream-survev/server
RUN apt-get update && apt-get install -y --no-install-recommends libexpat1 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/upstream-survev /app/upstream-survev
ENV NODE_ENV=production OPSIA_ROOM=true OPSIA_INFINITE=true SURVEV_CLIENT_DIR=/app/upstream-survev/client/dist
EXPOSE 8001
CMD ["node", "--enable-source-maps", "dist/gameServer.js"]
