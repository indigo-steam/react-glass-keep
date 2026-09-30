#!/usr/bin/env bash
# Crea (o deja lista) la instancia Hermes personal de un usuario de la app.
# - Contenedor oficial nousresearch/hermes-agent con HERMES_HOME propio
# - API server OpenAI-compatible (solo red interna indigo-assistant)
# - MCP de GlassKeep montado y configurado (stdio)
# - Herramientas: solo MCP + memoria persistente (sin terminal/browser)
#
# Uso:  ./install-hermes-user.sh <USER_ID> [GLASSKEEP_URL]
#   USER_ID:        id del usuario en la app (1 = primer usuario registrado)
#   GLASSKEEP_URL:  URL de la API de notas vista desde el contenedor Hermes
#                   (default: http://indigo-notes:8080)
#
# Después de este script corré:  ./store-hermes-key.sh <USER_ID>
# y luego cargá tu API key del LLM desde la app (Configuración → AI Assistant).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DIR/.." && pwd)"
USER_ID="${1:?uso: $0 <USER_ID> [GLASSKEEP_URL]}"
GLASSKEEP_URL="${2:-http://indigo-notes:8080}"
DATA_ROOT="${HERMES_DATA_ROOT:-$HOME/hermes-users}"
INSTANCE_DIR="$DATA_ROOT/$USER_ID"
CONTAINER="hermes-u$USER_ID"
NETWORK="indigo-assistant"
IMAGE="${HERMES_IMAGE:-nousresearch/hermes-agent:latest}"
MCP_DIR="$REPO_DIR/mcp"

[[ "$USER_ID" =~ ^[0-9]+$ ]] || { echo "USER_ID debe ser numérico"; exit 1; }
command -v docker >/dev/null || { echo "docker es requerido"; exit 1; }
command -v openssl >/dev/null || { echo "openssl es requerido"; exit 1; }

echo "==> Preparando dependencias del MCP ($MCP_DIR)"
if [ ! -d "$MCP_DIR/node_modules" ]; then
  docker run --rm -v "$MCP_DIR:/app" -w /app node:22-slim npm ci --omit=dev >/dev/null
fi

mkdir -p "$INSTANCE_DIR"
docker network inspect "$NETWORK" >/dev/null 2>&1 || { echo "==> Creando red $NETWORK"; docker network create "$NETWORK" >/dev/null; }

if [ ! -f "$INSTANCE_DIR/.api_server_key" ]; then
  umask 077
  openssl rand -hex 24 > "$INSTANCE_DIR/.api_server_key"
  echo "==> API key del API server generada (HERMES_HOME/.api_server_key)"
fi
API_KEY="$(cat "$INSTANCE_DIR/.api_server_key")"

if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "==> El contenedor $CONTAINER ya existe (no se recrea)"
else
  echo "==> Creando contenedor $CONTAINER"
  docker run -d --name "$CONTAINER" --restart unless-stopped \
    --network "$NETWORK" \
    --memory "${HERMES_MEMORY:-1200m}" \
    -v "$INSTANCE_DIR:/opt/data" \
    -v "$MCP_DIR:/opt/mcp:ro" \
    -e API_SERVER_ENABLED=true \
    -e API_SERVER_KEY="$API_KEY" \
    -e API_SERVER_HOST=0.0.0.0 \
    "$IMAGE" gateway run >/dev/null
fi

echo "==> Esperando a que Hermes arranque (puede tardar ~30s)"
READY=""
for _ in $(seq 1 45); do
  if docker exec "$CONTAINER" python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8642/health',timeout=2)" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
if [ -z "$READY" ]; then
  echo "Hermes no respondió. Revisá: docker logs $CONTAINER"
  exit 1
fi
echo "    /health OK"

# Persistir el API server en el .env del contenedor (sobrevive recreaciones sin -e)
docker exec "$CONTAINER" sh -c "
  grep -q '^API_SERVER_ENABLED=' /opt/data/.env 2>/dev/null || printf 'API_SERVER_ENABLED=true\nAPI_SERVER_KEY=%s\nAPI_SERVER_HOST=0.0.0.0\n' '$API_KEY' >> /opt/data/.env
" >/dev/null

echo "==> Habilitando solo MCP + memoria persistente (sin terminal/browser/file)"
docker exec "$CONTAINER" hermes config set platform_toolsets.api_server "[memory]" >/dev/null

if docker exec "$CONTAINER" hermes mcp list 2>/dev/null | grep -q glasskeep; then
  echo "==> El MCP 'glasskeep' ya estaba configurado"
else
  echo
  echo "Credencial de GlassKeep para el MCP:"
  echo "  En la app: menú (⋮) → Download secret key  (o creá una API key en Configuración)."
  read -r -s -p "  Pegá la secret key (Enter para omitir): " GK_SECRET
  echo
  if [ -n "$GK_SECRET" ]; then
    echo y | docker exec -i "$CONTAINER" hermes mcp remove glasskeep >/dev/null 2>&1 || true
    echo y | docker exec -i "$CONTAINER" hermes mcp add glasskeep --command node \
      --env GLASSKEEP_URL="$GLASSKEEP_URL" GLASSKEEP_SECRET_KEY="$GK_SECRET" \
      --args /opt/mcp/index.js >/dev/null
    echo "    MCP 'glasskeep' configurado (9 herramientas)"
  else
    echo "    Omitido. Configuralo luego con:"
    echo "      docker exec -it $CONTAINER hermes mcp add glasskeep --command node \\"
    echo "        --env GLASSKEEP_URL=$GLASSKEEP_URL GLASSKEEP_SECRET_KEY=<tu-secret-key> \\"
    echo "        --args /opt/mcp/index.js"
  fi
fi

docker restart "$CONTAINER" >/dev/null
echo
echo "Instancia lista ✅"
echo "Siguientes pasos:"
echo "  1) ./store-hermes-key.sh $USER_ID        (guarda la API key de Hermes en el vault de la app)"
echo "  2) En la app → Configuración → 'AI Assistant: provider & API key': pegá tu API key del LLM"
echo "  3) Escribí una pregunta en la barra de búsqueda (estrella ✨ activa el modo AI)"
