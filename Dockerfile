# syntax=docker/dockerfile:1

# --- Build & validate stage ---
FROM node:22.12.0-bookworm-slim AS builder

# Native deps for better-sqlite3 (node-gyp)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts=false

# Copy source and config
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
COPY tests/ tests/
COPY scripts/ scripts/

# Run full CI validation
RUN npm run typecheck
RUN npm run test
RUN npm run build
RUN npm run smoke

# --- Runtime stage ---
FROM node:22.12.0-bookworm-slim AS runtime

WORKDIR /app

# Copy built output and production deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts=false

COPY --from=builder /app/dist/ dist/

ENV NODE_ENV=production

# MCP server over stdio (default entrypoint for this tool)
CMD ["node", "dist/index.js"]
