#!/bin/sh
set -e

echo "→ Running Prisma migrations..."
node node_modules/prisma/build/index.js migrate deploy

if [ ! -f /home/.seeded ]; then
  echo "→ Seeding database (first run)..."
  node_modules/.bin/tsx prisma/seed.ts && touch /home/.seeded
fi

echo "→ Starting Next.js..."
exec node server.js
