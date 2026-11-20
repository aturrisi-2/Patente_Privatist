FROM node:22-bookworm-slim

# Build dependencies for better-sqlite3 (only needed if prebuild is unavailable)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY data ./data
COPY public ./public
COPY src ./src

RUN mkdir -p /app/db && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=3080
ENV HOST=0.0.0.0
ENV DB_PATH=/app/db/patente.sqlite

EXPOSE 3080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3080/api/health || exit 1

CMD ["node", "src/server.js"]
