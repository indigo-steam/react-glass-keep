# Self-hosting: Indigo Notes + tu propio agente AI

Guía para clonar este repositorio y montar tu propia instancia **con asistente AI**:
cada usuario tiene su **agente Hermes propio** (aislado), conectado a tus notas por el
**MCP de GlassKeep**, y el LLM se paga/us a con **tu propia API key (BYOK)** — nada de
claves en el navegador ni notas en servicios de terceros más allá del proveedor LLM que elijas.

```
Navegador → App (Express + React + SQLite)
               └─ /api/assistant/chat (SSE) → Hermes del usuario (contenedor, HERMES_HOME propio)
                                                 ├─ LLM cloud con SU api key (cifrada en el vault)
                                                 └─ MCP GlassKeep (stdio) → API de la app → SQLite
Host: hermes-waker (systemd) arranca/apaga contenedores Hermes on-demand
```

## Requisitos

- Linux con **Docker** (probado en VPS de 1 vCPU / 2 GB+; ~270–340 MB de RAM por asistente activo)
- **openssl** y **bash**
- Dominio + HTTPS recomendado (nginx/caddy) para la PWA
- Una **API key de LLM**: [OpenRouter](https://openrouter.ai/keys) o cualquier endpoint
  OpenAI-compatible (OpenAI, DeepSeek, Groq, etc.)
- Opcional para desarrollo local: Node.js 22+

## Parte 0 — Clonar

```bash
git clone https://github.com/indigo-steam/react-glass-keep.git indigo-notes
cd indigo-notes
```

## Parte 1 — La app (2 minutos)

1. Generá los secretos (no los commitees nunca):

```bash
mkdir -p ~/.glass-keep
JWT_SECRET="$(openssl rand -base64 48)"          # firma de sesiones
SECRETS_MASTER_KEY="$(openssl rand -base64 32)"  # cifra las API keys de los usuarios (BYOK)
```

2. Creá el env-file de producción `~/.glass-keep/indigo-notes.env` (chmod 600):

```env
NODE_ENV=production
API_PORT=8080
DB_FILE=/app/data/notes.db
JWT_SECRET=<el de arriba>
SECRETS_MASTER_KEY=<el de arriba>
ADMIN_EMAILS=<tu-usuario-admin>
ALLOW_REGISTRATION=false
# Asistente (completar después de la Parte 2)
HERMES_BASE_TEMPLATE=http://hermes-u{id}:8642
HERMES_WAKER_URL=http://host.docker.internal:8099
HERMES_WAKER_TOKEN=<token del waker>
ASSISTANT_IDLE_MINUTES=15
```

3. Build y arranque:

```bash
docker build -t indigo-notes:local .
docker network create indigo-assistant 2>/dev/null || true

docker run -d --name indigo-notes --restart unless-stopped \
  --network indigo-assistant \
  --add-host host.docker.internal:host-gateway \
  -p 127.0.0.1:8082:8080 \
  --env-file ~/.glass-keep/indigo-notes.env \
  -v ~/.glass-keep:/app/data \
  indigo-notes:local

curl -fsS http://127.0.0.1:8082/api/health   # {"ok":true,...}
```

4. Entrá a la app (por nginx/HTTPS o `http://localhost:8082`), registrate y creá el admin
   (el primer usuario cuyo email esté en `ADMIN_EMAILS` queda como admin).

> Para nginx alcanza con proxear todo a `127.0.0.1:8082` (ver ejemplo en
> `docs/hermes/2026-09-30-resultados-fase-5.md` o cualquier config de reverse proxy).

## Parte 2 — Waker (1 minuto)

El waker es un servicio del host que arranca/apaga los contenedores Hermes cuando el
asistente se usa (y los apaga tras 15 min sin uso para ahorrar RAM). No expone Docker:
solo `start/stop/config` de `hermes-u<id>`, protegido con un token.

```bash
./deploy/install-waker.sh
# Copiá el WAKER_TOKEN que imprime al env-file de la app (HERMES_WAKER_TOKEN) y recreá el contenedor:
docker rm -f indigo-notes && docker run -d ...   # mismo comando del paso 1.3
```

Si tenés `ufw` activo, el script agrega la regla necesaria para que la app llegue al waker.

## Parte 3 — Un Hermes por usuario (2 minutos por usuario)

```bash
./deploy/install-hermes-user.sh 1
#   USER_ID = id del usuario en la app (1 suele ser el primero registrado)
#   Te va a pedir tu "secret key" de GlassKeep: en la app, menú (⋮) → Download secret key
```

Qué hace el script:

- Crea la red `indigo-assistant` y el volumen `~/hermes-users/<id>` (`HERMES_HOME` propio)
- Arranca `nousresearch/hermes-agent` con su API server OpenAI-compatible y su API key
  (guardada en `HERMES_HOME/.api_server_key`)
- Monta el MCP de GlassKeep (`mcp/`, solo lectura) y lo configura por stdio con tu credencial
- Deja **solo** el MCP + memoria persistente como herramientas (sin terminal/browser/file)
- NO publica puertos: la app lo alcanza por nombre (`http://hermes-u1:8642`) dentro de la red

> ¿Más usuarios? Repetí con `2`, `3`, … Cada uno tendrá su agente, memoria y credenciales
> separadas (Hermes es single-tenant: un contenedor por usuario).

## Parte 4 — Conectar el vault y cargar tu API key (1 minuto)

1. Guardá la API key interna de Hermes en el vault cifrado de la app:

```bash
./deploy/store-hermes-key.sh 1
```

2. En la app: **Configuración → "AI Assistant: provider & API key"**:
   - Proveedor: **OpenRouter** (o Custom OpenAI-compatible + base URL)
   - Pegá tu API key y (opcional) el modelo, por ej. `google/gemini-3-flash-preview`
   - Guardar: valida la key contra el proveedor, la guarda **cifrada (AES-256-GCM)** y la
     aplica a tu instancia Hermes automáticamente (vía waker).

3. Probá: en la barra de búsqueda, la **estrella ✨** activa el modo AI. Escribí
   *"¿qué tengo pendiente?"* o *"buscá mi nota del auto"*.

> ¿Sin usuario en la app todavía? Registrate primero; el asistente se activa solo cuando
> haya API key guardada.

## Parte 5 — Usar tu propio agente externo (opcional)

El MCP también funciona con **cualquier cliente MCP** (Claude Desktop, tu Hermes propio,
Cursor, etc.) apuntando a tu instancia de la app:

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "indigo-notes": {
      "command": "node",
      "args": ["/ruta/al/repo/mcp/index.js"],
      "env": {
        "GLASSKEEP_URL": "https://notas.tu-dominio.com",
        "GLASSKEEP_API_KEY": "gk_... (o GLASSKEEP_SECRET_KEY=<secret key de la app>)"
      }
    }
  }
}
```

Detalles y herramientas disponibles: [`mcp/README.md`](../mcp/README.md).

## Operación

| Tema | Cómo |
|---|---|
| Logs de la app | `docker logs indigo-notes --tail 50` |
| Logs de un Hermes | `docker logs hermes-u1 --tail 50` |
| Logs del waker | `journalctl -u hermes-waker -n 50` |
| Backups (SQLite, WAL-safe) | `sudo sqlite3 ~/.glass-keep/notes.db ".backup ~/.glass-keep/backups/notes-$(date +%F).db"` |
| Idle-stop | Automático a los 15 min (`ASSISTANT_IDLE_MINUTES`); el primer mensaje tras el apagado tarda ~30 s |
| Rotar la API key del LLM | Configuración → AI Assistant → Change |
| Rotar la credencial del MCP | En la app generá otra secret key; reconfigurá con `install-hermes-user.sh` |
| Actualizar la app | `git pull && docker build -t indigo-notes:local .` + recrear el contenedor |
| Actualizar Hermes | `docker pull nousresearch/hermes-agent:latest` + `docker rm -f hermes-u1` + `./deploy/install-hermes-user.sh 1` |
| Memoria del agente | Archivo `~/hermes-users/<id>/memories/MEMORY.md` (por usuario) |

## Seguridad (resumen)

- Los secretos de usuarios (API keys BYOK, credenciales MCP) se guardan **cifrados** y nunca
  se devuelven al navegador (solo `••••last4`).
- El waker está protegido por token y solo opera `hermes-u<id>`.
- Los LLM keys quedan en la conversación con el proveedor que **vos** elijas; las notas se
  consultan vía API con la credencial de cada usuario.
- Ver [`SECURITY.md`](../SECURITY.md) para más detalle.

## Troubleshooting

| Síntoma | Causa probable / solución |
|---|---|
| 404 de nginx | Estás entrando por otro host (IP o dominio sin config). Usá el `server_name` configurado |
| "El asistente no está disponible" (503) | Hermes arrancando (esperá ~30 s) o contenedor caído: `docker logs hermes-u1` |
| 409 "Configurá tu API key" | Falta guardar la API key del LLM en Configuración |
| El asistente no responde en el móvil | Cerrá la PWA por completo y reabrí (el service worker se actualiza solo desde entonces) |
| El waker no responde desde la app | Token distinto entre `hermes-waker.env` y el env-file de la app; o ufw bloqueando el 8099 |
| `hermes mcp test glasskeep` falla | URL de GlassKeep incorrecta o credencial inválida (regenerala en la app) |

## Desarrollo local (sin Hermes)

```bash
npm ci
cat > .env.local <<'EOF'
JWT_SECRET=dev-local-secret
SECRETS_MASTER_KEY=<openssl rand -base64 32>
DB_FILE=./data/dev.sqlite
API_PORT=8080
ALLOW_REGISTRATION=true
SEED_DEFAULT_ADMIN=true
EOF
npm run dev   # Vite 5173 + API 8080
```

El server carga `.env.local` automáticamente en desarrollo. El asistente requiere Hermes,
así que en local verás 409/503 hasta que montes los contenedores (podés apuntar
`HERMES_BASE_TEMPLATE` a un mock, ver `mcp/test/smoke.mjs` para correr el MCP contra
una instancia local).
