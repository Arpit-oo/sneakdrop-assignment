FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production PORT=3000
EXPOSE 3000

# Migrate (safe to repeat), make sure the product exists, then serve.
# `exec` so the server gets SIGTERM directly and shuts down cleanly.
CMD ["sh", "-c", "npx tsx src/db/migrate.ts && npx tsx src/db/seed.ts && exec npx tsx src/server.ts"]
