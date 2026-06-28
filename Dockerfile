FROM node:20-alpine

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

# Copy application source
COPY server.js sources.js engines.js news-engine.js broadcast.js tts.js orchestrator.js presets.js rss-presets.js rss-sources.js feed-health.js speech-engines.js storage.js ./
COPY public ./public

EXPOSE 3000

CMD ["node", "server.js"]
