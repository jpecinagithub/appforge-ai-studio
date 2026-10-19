# Docker CLI is copied into the trusted Studio only. Generated applications
# use their own locked Dockerfile and never receive the daemon socket.
FROM docker:27.5.1-cli AS docker-cli

FROM node:24-slim AS studio-build
WORKDIR /build/apps/studio
COPY apps/studio/package.json apps/studio/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY apps/studio/ ./
ENV VITE_API_URL=""
RUN npm run build

FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates chromium \
  && rm -rf /var/lib/apt/lists/*

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY packages/shared/package.json packages/shared/
RUN npm ci --workspaces --include-workspace-root --no-audit --no-fund \
  && npm install --global tsx@4 \
  && npm cache clean --force

COPY apps/server apps/server
COPY apps/worker apps/worker
COPY packages/shared packages/shared
COPY templates templates
COPY --from=studio-build /build/apps/studio/dist apps/studio/dist

# The unattended installers use umask 077 while handling secrets. A Git update
# can therefore materialize changed source files as 0600 on the host. Normalize
# only the immutable image contents before dropping privileges; runtime data in
# /data/appforge keeps its restrictive permissions.
RUN chmod -R a+rX /app/apps /app/packages /app/templates

ENV DATA_DIR=/data/appforge \
    APPFORGE_BROWSER_EXECUTABLE=/usr/bin/chromium \
    NODE_ENV=production \
    HOME=/tmp/appforge-home
EXPOSE 3001

# The compose data-init service prepares the persistent volume for this UID.
USER 1000:1000
CMD ["npx", "tsx", "apps/server/src/index.ts"]
