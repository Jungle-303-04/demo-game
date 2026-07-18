FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY services/control-plane-auth.ts ./services/control-plane-auth.ts
COPY services/room-profiles.ts ./services/room-profiles.ts
COPY services/room-orchestrator ./services/room-orchestrator
RUN npm run build:server

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8082
CMD ["node", "dist/services/room-orchestrator/src/main.js"]
