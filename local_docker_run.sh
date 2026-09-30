#!/bin/bash

# Indigo Notes Docker Deployment Script
# This script builds and runs the Indigo Notes application in a Docker container

set -e  # Exit on any error

echo "🧹 Removing existing indigo-notes container (if exists)..."
docker rm -f indigo-notes 2>/dev/null || true

# Never hardcode secrets: read from .env.local or require JWT_SECRET in the environment
if [ -f .env.local ]; then
  echo "📄 Loading .env.local..."
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi
if [ -z "${JWT_SECRET:-}" ]; then
  echo "❌ JWT_SECRET is not set. Export it or add it to .env.local:" >&2
  echo "   export JWT_SECRET=\$(openssl rand -base64 48)" >&2
  exit 1
fi

echo "🏗️  Building indigo-notes Docker image..."
docker build -t indigo-notes:local .

echo "🚀 Starting indigo-notes container..."
docker run -d \
  --name indigo-notes \
  --restart unless-stopped \
  -p 8080:8080 \
  -e NODE_ENV=production \
  -e API_PORT=8080 \
  -e JWT_SECRET \
  -e DB_FILE="${DB_FILE:-/app/data/notes.db}" \
  -e ADMIN_EMAILS="${ADMIN_EMAILS:-}" \
  -e ALLOW_REGISTRATION="${ALLOW_REGISTRATION:-false}" \
  -v "$HOME/.glass-keep:/app/data" \
  indigo-notes:local

echo "✅ Local Deployment complete!"
echo "🌐 Application should be available at http://localhost:8080"
echo "� Stop container: docker stop indigo-notes"
echo "� Streaming logs (Press Ctrl+C to stop viewing logs, container will keep running)..."
docker logs -f indigo-notes
