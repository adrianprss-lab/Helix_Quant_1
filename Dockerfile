# HELIX QUANT — single-image deployment (app + schema push)
# Build:  docker compose up -d --build
# The container pushes the Drizzle schema on boot, then serves Next.js.
FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# drizzle-kit push is idempotent: it creates missing tables/columns and leaves
# existing data untouched, so restarting the container never damages the DB.
CMD ["sh", "-c", "npx drizzle-kit push && npx next start -p 3000"]
