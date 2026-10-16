# ---- frontend build ----
FROM node:24-slim AS frontend-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ---- backend build ----
FROM node:24-slim AS backend-build
WORKDIR /build/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# ---- runtime ----
FROM node:24-slim
RUN useradd -m -u 1001 appuser
WORKDIR /app
# Production deps only; no devDependencies in the image.
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev && npm cache clean --force
COPY --from=backend-build /build/backend/dist ./backend/dist
COPY --from=frontend-build /build/frontend/dist ./frontend/dist
COPY migrations ./migrations
# /data is the SQLite volume mount point (never baked into the image).
RUN mkdir -p /data && chown -R appuser:appuser /app /data
USER appuser
EXPOSE 8080
ENV PORT=8080 \
    NODE_ENV=production \
    DB_PATH=/data/app.db
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
# server.ts runs pending migrations, then listens.
CMD ["node", "backend/dist/server.js"]
