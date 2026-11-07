# Platform API image.
#
# Two things to know (changed 6 Nov 2026, plans/integration worklog 62):
#   1. Configuration is NOT in the image. .dockerignore keeps config/config.env and .env files
#      out, so no secret is baked in. Pass the settings at run time: `--env-file`, compose
#      `env_file`, or mount a file at /app/config/config.env.
#   2. Node 22 and a compiler in the deps stage, so the optional `re2` module installs (it has no
#      prebuilt binary for Node 20, and its build fallback needs Node 22). Without it the API
#      starts with regex rule conditions disabled (utils/safeRegex.js logs that at boot).

# ---- deps ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# Chromium comes from apt in the runner stage: skip Puppeteer's own download.
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runner ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV LIBREOFFICE_PATH=/usr/bin/soffice
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        chromium \
        libreoffice-writer \
        fonts-liberation \
        fonts-dejavu \
        fonts-crosextra-carlito \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /tmp && chmod 1777 /tmp

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN addgroup --system app && adduser --system --ingroup app app && \
    mkdir -p public/uploads && chown -R app:app public
USER app

EXPOSE 6830
CMD ["node", "server.js"]
