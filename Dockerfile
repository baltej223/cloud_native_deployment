# One Dockerfile, one target per service: api, migrate, web.
#   docker build --target api -t cloud-platform-api .

FROM node:22-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---- Install all workspace dependencies (cached until a manifest changes) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/platform/package.json packages/platform/
COPY packages/drivers/package.json packages/drivers/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci

# ---- Compile shared packages and backend services ----
FROM deps AS build-backend
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN npm run build:packages \
  && npm run build -w @cloud-platform/api \
  && npm prune --omit=dev

# ---- Backend runtime (shared by api and migrate) ----
FROM base AS backend
ENV NODE_ENV=production
COPY --from=build-backend /app/package.json ./
COPY --from=build-backend /app/node_modules ./node_modules
COPY --from=build-backend /app/packages ./packages
USER node

FROM backend AS migrate
CMD ["node", "packages/platform/dist/migrate-cli.js"]

FROM backend AS api
# git clones repositories; the Docker CLI with buildx builds them with BuildKit.
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=docker.io/library/docker:28.4.0-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker.io/library/docker:28.4.0-cli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
USER node
COPY --from=build-backend /app/apps/api/package.json ./apps/api/
COPY --from=build-backend /app/apps/api/dist ./apps/api/dist
EXPOSE 3001
CMD ["node", "apps/api/dist/server.js"]

# ---- Web: NEXT_PUBLIC_* values are inlined at build time ----
FROM deps AS build-web
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN npm run build -w @cloud-platform/contracts \
  && npm run build -w @cloud-platform/web \
  && npm prune --omit=dev

FROM base AS web
ENV NODE_ENV=production
COPY --from=build-web /app/package.json ./
COPY --from=build-web /app/node_modules ./node_modules
COPY --from=build-web /app/packages/contracts ./packages/contracts
COPY --from=build-web /app/apps/web/package.json /app/apps/web/next.config.mjs ./apps/web/
COPY --from=build-web /app/apps/web/.next ./apps/web/.next
USER node
WORKDIR /app/apps/web
EXPOSE 3000
CMD ["node", "/app/node_modules/next/dist/bin/next", "start", "--port", "3000"]
