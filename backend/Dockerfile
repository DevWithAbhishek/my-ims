# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /app
# Prisma CLI (used by `npm run build` -> prisma generate) needs OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# API process. The worker process uses the same image: `node dist/worker.js`.
CMD ["node", "dist/main.js"]
