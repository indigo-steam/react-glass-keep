# Plan de trabajo local → producción — Indigo Notes
## Seguridad → Runtime → Asistente agéntico (Hermes + MCP)

> Documento de trabajo para llevar a la máquina local y ejecutar por fases.
> Basado en la auditoría técnica del 2026-09-30 (rama `main`, commit `d52b4cc` del historial original).
> El historial fue reescrito el 2026-09-30 para purgar `data/notes.db*` (ver §4.1), por lo que los
> hashes de commits anteriores a esa fecha ya no existen en `origin`.
> Repo desplegado en el servidor: `/home/ubuntu/indigo-notes`, remoto `indigo-steam/react-glass-keep`.

---

## 0. Contexto que debes conocer antes de empezar

**Estado actual del despliegue**
- Contenedor `indigo-notes` (`indigo-notes:local`), `127.0.0.1:8082 → 8080`, detrás de nginx en `notes.indigosteam.com`.
- Base de datos viva: `~/.glass-keep/notes.db` (montada en `/app/data`). 260 notas, 2 usuarios, 5 colaboraciones.
- Servidor: 1 vCPU, 2.7 GB RAM disponible, disco al 94% (2.9 GB libres). `~/.glass-keep/ai-cache` = 1.6 GB.
- Imagen Docker: 1.46 GB. Runtime: Node 18 (EOL).

**Hallazgos críticos de la auditoría (referencia)**
| ID | Hallazgo | Ubicación |
|---|---|---|
| S1 | `data/notes.db*` con hashes bcrypt trackeado en git | `git ls-files data`, commit `3d6f37d` |
| S2 | `JWT_SECRET=dev-please-change` en producción | `local_docker_run.sh`, env del contenedor, fallback en `server/index.js:46` |
| S3 | XSS almacenado: `marked` + `dangerouslySetInnerHTML` sin sanitizar | `src/App.jsx:2765` y `src/App.jsx:5987` |
| S4 | `/api/users/search` expone todos los usuarios | `server/index.js:1123-1141` |
| S5 | JWT del SSE viaja en query string | `src/App.jsx:4069-4071`, `server/index.js:246-264` |
| S6 | Sin rate limiting en login/secret-login | `server/index.js:505-561` |
| S7 | Se crea admin `admin/admin` si la tabla está vacía | `server/index.js:271-282` |

**Arquitectura objetivo (al final del plan)**

Decisión 2026-09-30 (multi-usuario): **un Hermes por usuario** (Hermes es single-tenant
por diseño: un proceso = un `config.yaml` = una credencial MCP y una memoria), **BYOK**
(cada usuario trae su API key LLM, cifrada en reposo) y **OpenRouter + endpoints custom
OpenAI-compatible** como proveedores. Instancias idle-stop en el VPS (1-3 usuarios).
Los usuarios que prefieran su propio agente externo (Claude Desktop, Hermes propio)
siguen usando el MCP público con su secret key.

```
Usuario → Glass Keep Web UI → Assistant API (Node, rutas por usuario)
                                  └→ Hermes del usuario (contenedor, HERMES_HOME propio)
                                       ├─ Cloud LLM con SU api key (BYOK, cifrada)
                                       └─ GlassKeep MCP (stdio) con SU credencial
                                            └→ Glass Keep API → SQLite
```

Contexto de la decisión (verificado 2026-09-30):
- Hermes Agent = NousResearch/hermes-agent; "single-tenant personal agent" por security policy.
- Superficie de integración: `hermes serve` expone API server OpenAI-compatible (`/v1/chat/completions`).
- MCP servers se configuran por proceso (`HERMES_HOME`/`config.yaml`); memoria (`USER.md`) global por instancia.
- Multi-tenant orchestrator nativo: feature request abierto (#82701); no esperarlo.

---

## 1. Preparar el entorno local

### 1.1 Requisitos de la máquina local
- [ ] Node.js 22 LTS instalado (`node -v`), npm 10+.
- [ ] Git configurado.
- [ ] Docker + Docker Compose (para probar la imagen como en producción).
- [ ] Acceso SSH al servidor (para copiar respaldos y desplegar).
- [ ] `sqlite3` CLI (o Python 3) para inspeccionar respaldos.

### 1.2 Clonar y arrancar
- [ ] `git clone https://github.com/indigo-steam/react-glass-keep.git indigo-notes`
- [ ] `cd indigo-notes && npm ci`
- [ ] Verificar que `npm run build` compila sin errores.
- [ ] Crear `.env.local` (no commitear) con:
  ```
  JWT_SECRET=<generar con: openssl rand -base64 48>
  DB_FILE=./data/dev.sqlite
  API_PORT=8080
  NODE_ENV=development
  ALLOW_REGISTRATION=true
  SEED_DEFAULT_ADMIN=true
  ```
  El server carga `.env.local` automáticamente en desarrollo (dotenv, nunca en producción).
- [ ] Arrancar API y web: `npm run dev` (Vite en 5173 con proxy a 8080).

### 1.3 Base de datos para desarrollo
- [ ] **Opción A (recomendada): DB limpia.** No copiar producción. Al arrancar,
  `server/index.js` crea las tablas y siembra `admin/admin` solo si
  `SEED_DEFAULT_ADMIN=true` (S7, dev únicamente). Registrar un
  usuario de prueba y crear 10-20 notas de ejemplo.
- [ ] **Opción B: copia anonimizada de producción.** Solo si necesitas volumen
  realista. Copiar con WAL consistente, nunca el `.db` a pelo:
  ```bash
  ssh ubuntu@servidor 'sqlite3 ~/.glass-keep/notes.db ".backup /tmp/notes-dev.db"'
  scp ubuntu@servidor:/tmp/notes-dev.db ./data/dev.sqlite
  ```
  Luego anonimizar `users` y no commitear nunca ese archivo.
- [ ] Confirmar que `.gitignore` excluye `data/` y `*.db` (hoy el `.gitignore`
  está malformado en las líneas 25-36; se corrige en Fase 2).

**Criterio de hecho**: app completa funcionando en local (login, crear/editar/borrar nota, tags, checklist).

---

## 2. Flujo de ramas y despliegue (usar en TODAS las fases)

### 2.1 Ramas
- [ ] `main` = espejo de producción. Nunca desarrollar directo en `main`.
- [ ] Una rama por fase: `fix/seguridad`, `chore/runtime-node22`, `feat/mcp-readonly`, etc.
- [ ] Commits pequeños con mensaje claro en inglés (estilo del repo: `feat(...)`, `fix(...)`).
- [ ] Antes de mezclar: `npm run build` + prueba manual del flujo afectado.

### 2.2 Despliegue en el servidor (solo cuando la fase esté probada)
- [ ] Respaldo previo de la DB (con WAL):
  ```bash
  ssh ubuntu@servidor 'sqlite3 ~/.glass-keep/notes.db ".backup ~/.glass-keep/backups/notes-$(date +%Y%m%d-%H%M%S).db"'
  ```
- [ ] `git fetch && git checkout <rama-o-tag>`
- [ ] `docker build -t indigo-notes:<tag> .`
- [ ] Reemplazo con rollback disponible:
  ```bash
  docker rm -f indigo-notes-old 2>/dev/null || true
  docker rename indigo-notes indigo-notes-old
  docker stop indigo-notes-old   # libera el puerto 8082 para el contenedor nuevo
  docker run -d --name indigo-notes --restart unless-stopped \
    -p 127.0.0.1:8082:8080 \
    --env-file ~/.glass-keep/indigo-notes.env \
    -v "$HOME/.glass-keep:/app/data" \
    indigo-notes:<tag>
  ```
- [ ] Health check: `curl -fsS http://127.0.0.1:8082/api/health`
- [ ] Prueba manual en `https://notes.indigosteam.com` (login, listar, crear, editar).
- [ ] Rollback si falla:
  ```bash
  docker rm -f indigo-notes && docker rename indigo-notes-old indigo-notes && docker start indigo-notes
  ```
- [ ] Limpiar imágenes viejas (`docker image prune`) — el disco está al 94%.

**Regla**: nada se edita dentro del contenedor. Todo cambio nace en una rama local.

---

## 3. Fase 1 — URGENTE en producción (sin esperar al desarrollo local)

**Objetivo**: cerrar S2 mientras se trabaja localmente. Es independiente del resto.

- [x] Generar secreto real: `openssl rand -base64 48`
- [x] Crear `~/.glass-keep/indigo-notes.env` en el servidor (chmod 600):
  ```
  NODE_ENV=production
  API_PORT=8080
  DB_FILE=/app/data/notes.db
  JWT_SECRET=<secreto real>
  ADMIN_EMAILS=adminniku
  ALLOW_REGISTRATION=false
  ```
- [x] Recrear el contenedor con `--env-file` y el secreto nuevo (mismo procedimiento §2.2).
- [x] Verificar que el secreto viejo ya no sirve: un JWT firmado con
  `dev-please-change` debe recibir 401 en `/api/notes`.
- [x] Anotar fecha de rotación. Consecuencia esperada: **todos los usuarios
  deben volver a iniciar sesión** (los JWT viejos quedan inválidos).

**✅ Completada el 2026-09-30** (backup previo: `notes-20260930-072506.db`,
verificado con `integrity_check` ok y 260 notas / 2 usuarios). Verificación:
JWT firmado con `dev-please-change` → 401; `/api/health` ok local y vía
`https://notes.indigosteam.com`. Contenedor anterior conservado como
`indigo-notes-old` para rollback; eliminar tras confirmar que los usuarios
pueden volver a loguearse.

**Criterio de hecho**: `docker inspect indigo-notes` ya no muestra el secreto público; usuarios pueden loguearse de nuevo.

---

## 4. Fase 2 — Seguridad en código (rama `fix/seguridad`)

**Objetivo**: cerrar S1, S3, S4, S6, S7 y sanear el repositorio. Sin features nuevas.

### 4.1 Sacar la DB del repositorio (S1)
- [x] `git rm --cached data/notes.db data/notes.db-shm data/notes.db-wal`
- [x] Reescribir `.gitignore` (hoy tiene un heredoc pegado en las líneas 25-36) dejando reglas limpias para `*.db`, `*.sqlite*`, `.env*`, `data/`.
- [x] Purgar del historial con `git filter-repo` (o BFG). Esto reescribe historia:
  - [x] Coordinar force-push de `main`.
  - [x] Asumir que los hashes bcrypt del repo quedaron expuestos: **rotar la
    contraseña de cualquier cuenta repetida** (el admin local `admin1`/`apu` del
    repo). Verificado: esas cuentas son solo del repo dev, no existen en producción.
- [x] Verificar: `git log --all -- data/notes.db` no devuelve nada.

### 4.2 Sanitizar Markdown (S3)
- [x] Añadir `dompurify` (`npm i dompurify`).
- [x] Sanear en los dos puntos: contenido de nota (`src/App.jsx:5987`) y respuesta IA (`src/App.jsx:2765`), más el tercer parseo en `mdToPlain` (previews de lista).
- [x] Prueba XSS: crear nota con contenido `<img src=x onerror="alert(1)">` → no debe ejecutar.
- [x] Prueba no-regresión: negritas, listas, código, enlaces y checkboxes siguen renderizando.

### 4.3 Endurecer auth (S4, S6, S7)
- [x] `/api/users/search` (`server/index.js:1123-1141`): exigir `q` de mínimo 3
  caracteres y devolver solo coincidencias; no listar todo con query vacía.
- [x] Rate limit con `express-rate-limit` en `/api/login` y `/api/login/secret`
  (p. ej. 10 intentos / 15 min por IP).
- [x] Eliminar el seed automático `admin/admin` (`server/index.js:271-282`) o
  condicionarlo a `SEED_DEFAULT_ADMIN=true` solo en desarrollo.
- [x] Fallar al arrancar en producción si `JWT_SECRET` no está definido
  (reemplazar el fallback inseguro de `server/index.js:46`).

### 4.4 Opcional pero recomendado
- [x] Persistir `adminSettings` (hoy en memoria, `server/index.js:1057-1060`) para que el toggle de registro sobreviva reinicios.
- [x] Añadir `helmet` y una CSP básica.
- [x] Evaluar S5 (token SSE en query): mover a cookie `HttpOnly` o ticket de un
  solo uso; si se posterga, dejar TODO documentado. **Postergado** con TODO en
  `src/App.jsx` (EventSource) y `server/index.js` (`authFromQueryOrHeader`).

### 4.5 Verificación de la fase
- [x] `npm run build` limpio.
- [x] Pruebas manuales: login, registro (con flag), CRUD notas, colaboración, SSE en dos pestañas.
- [x] Desplegar según §2.2 y repetir pruebas en producción.

**✅ Completada el 2026-09-30** — commit `b8a0925`, imagen `indigo-notes:security-20260930`, backup previo `notes-20260930-074202.db`. Notas:
- Bug preexistente encontrado y corregido: `src/ai.js` importaba `i18n` dos veces y rompía `npm run build` (commit `58e0ff9`).
- `local_docker_run.sh` ya no hardcodea el secreto: exige `JWT_SECRET` o lo lee de `.env.local` (S2 lado repositorio).
- El server ahora carga `.env.local` en desarrollo (dotenv, solo fuera de producción) — ver §1.2.
- `adminSettings` se persiste en `admin-settings.json` junto a la DB (sin cambios de esquema).
- La rotación de secreto y el fail-fast dejan `dev-secret-please-change` solo como fallback de desarrollo.
- Force-push del historial reescrito el 2026-09-30; el clon del VPS quedó sincronizado con `git reset --hard origin/main`.

**Criterio de hecho**: los 7 hallazgos cerrados o con TODO explícito; ningún secreto en repo.

---

## 5. Fase 3 — Runtime y dependencias (rama `chore/runtime`)

**Objetivo**: actualizar con criterio, no "a lo loco". Sin cambios funcionales.

- [x] Usar Context7 para consultar APIs actuales antes de tocar cada librería
  (herramientas `resolve-library-id` y `query-docs`; por ejemplo: "Express 5
  migration guide", "better-sqlite3 latest API").
- [x] Subir el runtime del `Dockerfile` de `node:18-slim` a `node:22-slim` (LTS).
- [x] Revisar/actualizar una por una, con build + smoke test entre cada una:
  - [x] `better-sqlite3` (nativa: verificar rebuild en arm64 dentro de Docker) → v13 (N-API 10, prebuilds Node 22, sin compilar)
  - [x] `express` 4 → 5 (revisar sintaxis de rutas `*` en el fallback SPA, `server/index.js:1359`) → wildcard migrado a `/{*splat}`
  - [x] `bcryptjs` (→ v3, verificado que valida hashes `$2a$` de v2), `jsonwebtoken` 9.0.3, `cors` 2.8.6
  - [x] Grupo Vite/React/Tailwind (solo si hay motivo; ya están recientes) → dentro de rango: React 19.3, Vite 7.3.6, Tailwind 4.3.3, i18next 26.4.2, marked 16.4.2, vite-plugin-pwa 1.3.0
- [x] Quitar del `Dockerfile` los pasos heredados de `sharp`/`libvips` si ya no se usan → eliminados; sharp prebuilt verificado dentro del contenedor.
- [x] Construir imagen y medir tamaño/consumo; anotar antes/después → **1.47 GB → 795 MB (−46%)**; RAM en reposo ~32 MB.

**✅ Completada el 2026-09-30** — commit `214170f`, imagen `indigo-notes:runtime-20260930`, backup previo `notes-20260930-080006.db`. Notas:
- `@huggingface/transformers` se dejó en 3.8.1 a propósito: su actualización a 4.x es breaking y la librería entera se elimina en Fase 7. Quedan 2 vulnerabilidades high de `sharp`/libvips heredadas por transformers (no alcanzables: solo se usa text-generation on-demand); se cierran al eliminar transformers.
- Auditoría npm: 30 vulnerabilidades → 2 (solo las de sharp/transformers).
- El contenedor de rollback `indigo-notes-old` ahora ejecuta la imagen `security-20260930`; la imagen Node 18 pre-seguridad (`:local`) fue eliminada. Disco del VPS: 94% → 85%.
- Verificado en contenedor real: Node v22.23.3, sharp prebuilt, CSP/headers, SPA fallback, login/registro/CRUD y prueba XSS sin ejecución con las versiones nuevas.

---

## 6. Fase 4 — MCP solo lectura (rama `feat/mcp-readonly`)

**Objetivo**: primer MCP contra la API existente. **Sin cambios de base de datos.**
Puede construirse contra `GET /api/notes` sin tocar el backend.

- [x] Crear carpeta `mcp/` con su `package.json` (no mezclar con el frontend).
- [x] Decorar herramientas mínimas:
  - [x] `search_notes(query?, tags?[], include_archived?, limit=20)`
  - [x] `get_note(id)`
  - [x] `list_tags()`
  - [x] `get_context(note_id?, query?, max_notes=10)`
- [x] Credencial del MCP: por ahora `POST /api/login/secret` (existe) para obtener
  JWT; documentar que en Fase 6 se añadirá `POST /api/api-keys` por usuario.
  (También soporta `GLASSKEEP_TOKEN` para pruebas; documentado en `mcp/README.md`.)
- [x] Probar con MCP Inspector: buscar "moto", "Fintrak", "SENA" y verificar que
  devuelve solo notas del usuario autenticado.
- [ ] Opcional backend (mejora, no bloqueante): `GET /api/notes/:id` y
  `GET /api/notes?tag=` para evitar traer todo. **Pospuesto**: con 260 notas el
  filtrado client-side del MCP es suficiente; anotado como mejora futura.

**✅ Completada el 2026-09-30** — commit `0db4af0`, SDK `@modelcontextprotocol/sdk@1.31.0` + `zod@3.25`. Notas:
- Herramientas solo-lectura: `GET /api/notes` + `GET /api/notes/archived`; nunca SQLite ni token admin. Data URLs de imágenes se reemplazan por marcador para no inflar el contexto.
- Smoke test propio autocontenido (`mcp/test/smoke.mjs`, `npm run smoke`): siembra dos usuarios, y verifica herramientas, tags case-insensitive y aislamiento A↔B. **12/12 ok**.
- Inspector CLI verificado (`tools/list` y `tools/call`). Ojo: el Inspector no hereda variables arbitrarias del entorno; hay que lanzarlo como `--cli env KEY=VAL node index.js`.
- Prueba con datos reales en producción: búsquedas "moto" (7), "Fintrak" (20) y "SENA" (20) contra `https://notes.indigosteam.com` usando un JWT temporal de 1 h firmado dentro del contenedor (no se creó ninguna credencial persistente adicional).
- `npm audit` del MCP: 0 vulnerabilidades.
- Sin deploy: el MCP corre local/stdio; se instalará en el servidor en Fase 5 junto a Hermes.

---

## 7. Fase 5 — Hermes base + 1 instancia (dueño) (rama/config `feat/hermes`)

**Objetivo revisado**: validar Hermes en el VPS con **una instancia para el dueño**
(Indigo), sin vault todavía. La multi-usuario real llega en Fase 6 (credenciales) y
Fase 7 (provisioning por usuario).

- [x] Imagen Docker de Hermes (Python + `hermes-agent[mcp]` + Node para el MCP stdio) y volumen `HERMES_HOME=/data/hermes-users/<id>`.
- [x] Config de la instancia del dueño:
  - [x] Provider `openrouter` (o custom OpenAI-compatible) con **su** API key, solo en `~/.hermes/.env` dentro del contenedor (nunca en repo/frontend).
  - [x] `mcp_servers.glasskeep`: `command: node`, `args: ["/app/mcp/index.js"]`, `env: GLASSKEEP_URL=https://notes.indigosteam.com` + credencial del usuario.
  - [x] Toolsets acotados (solo MCP glasskeep al inicio) → `platform_toolsets.api_server: []` (0 tools built-in).
- [x] Credencial MCP del dueño: secret key dedicada del asistente (revocable rotando desde la UI); nunca un token admin. *(Temporal: JWT 365d; se reemplaza en Fase 6.)*
- [x] Pruebas read-only por `hermes serve` (API OpenAI-compatible):
  - [x] "¿Qué tengo pendiente relacionado con SENA?"
  - [x] "Busca mis notas de Fintrak"
  - [x] "Busca la nota del cambio de aceite de la moto"
- [x] Medir consumo de Hermes + MCP en el servidor (1 vCPU / 5.8 GB): CPU, RAM en reposo y en consulta, tiempo de arranque, disco de la imagen.
- [x] Documentar resultados en `docs/` y decidir política de idle-stop (Fase 7).

**✅ Completada el 2026-09-30** — resultados completos en `docs/hermes/2026-09-30-resultados-fase-5.md`. Resumen:
- Contenedor `hermes-u1` con imagen oficial `nousresearch/hermes-agent:latest` (v0.21.5) + MCP de GlassKeep (stdio, montado read-only) + API server OpenAI-compatible en `127.0.0.1:8643`.
- Las 3 consultas devolvieron respuestas correctas citando notas reales; streaming SSE verificado.
- Consumo: arranque 21 s; RAM ~270–337 MB; CPU <0.5 %; imagen 2.69 GB; `HERMES_HOME` 75 MB/usuario; disco VPS al 92 % (la limpieza de `ai-cache` en Fase 7 libera 1.6 GB).
- Mejora detectada para Fase 6: aceptar alias `queries` en `search_notes` (el modelo lo intentó y el schema lo rechazó; reintentó con éxito).
- Pendiente operativo: reemplazar el JWT temporal del MCP por la secret key del usuario o `api-keys` (Fase 6), y la OpenRouter key temporal por la UI BYOK.

---

## 8. Fase 6 — MCP escritura + credenciales del asistente (rama `feat/mcp-write`)

### 8.1 MCP escritura
- [x] Herramientas:
  - [x] `create_note(title, content?, tags?, type?, items?)` → `POST /api/notes`
  - [x] `update_note(id, cambios)` → `PATCH /api/notes/:id` (nunca `PUT`; siempre leer antes de escribir)
  - [x] `archive_note(id, archived)` → `POST /api/notes/:id/archive`
  - [x] `restore_note(id)` → `POST /api/notes/:id/restore`
  - [x] `delete_note(id, confirm:true)` → `DELETE /api/notes/:id` (jamás `permanent=1`)
- [x] Decidir identidad/auditoría del agente (hoy `last_edited_by` es texto libre,
  `server/index.js:690`): usuario bot colaborador **o** marcador `"Asistente"`. → header `X-Edited-By`, default `"Asistente"`.
- [x] Confirmación obligatoria para operaciones destructivas (diálogo en UI o flag `confirm`).
- [x] Pruebas de aislamiento: token del usuario A no puede leer/editar notas del usuario B (salvo colaboración explícita).

### 8.2 Credenciales por usuario (BYOK + MCP del asistente)
- [x] **Ajuste de regla de oro**: los cambios de esquema llegan en esta fase (migraciones idempotentes estilo `server/index.js`), no en Fase 9.
- [x] Tabla `user_secrets` (cifrado AES-256-GCM con `SECRETS_MASTER_KEY` en env del contenedor web):
  - [x] API key LLM del usuario (BYOK) + proveedor/modelo/base URL opcional.
  - [x] Credencial MCP del asistente generada por el servidor (revocable), inyectada al provisionar su instancia Hermes.
- [x] Endpoints (auth JWT):
  - [x] `GET /api/assistant/credentials` → estado enmascarado (proveedor, `••••last4`, modelo).
  - [x] `PUT /api/assistant/credentials` → guardar/validar (test call al provider antes de aceptar).
  - [x] `DELETE /api/assistant/credentials` → revocar.
  - [x] `POST /api/api-keys` (para agentes externos BYO): hasheada, scopes read/write, revocable.
- [x] Validación para OpenRouter + endpoints custom OpenAI-compatible (los dos soportados).

**✅ Completada el 2026-09-30** — commits `9e2dcc0`, `09e5761`, `7f1ba3f`; imagen `indigo-notes:mcp-write-20260930`; backup previo `notes-20260930-100148.db`. Notas:
- Migración: tablas `api_keys` y `user_secrets` (idempotentes); `SECRETS_MASTER_KEY` agregada al env-file de producción.
- Auth extendida: Bearer `gk_...` con scopes (`read` no puede escribir → 403), revocación inmediata (401), `last_used_at`, y `X-Edited-By` para auditoría (`lastEditedBy` = "Asistente" verificado).
- MCP: **9 tools** (4 lectura + 5 escritura), alias `queries` (el modelo lo intentaba y fallaba), `GLASSKEEP_API_KEY` soportada, errores de API con detalle.
- Smoke local **23/23** (incluye escritura, archivado, confirmación de borrado y aislamiento A↔B en lectura/escritura/borrado).
- Swap en producción: la credencial del asistente pasó del JWT temporal a una **API key gestionada** (`gk_...`, scope write, cifrada en el vault) inyectada en `hermes-u1`; verificado end-to-end: el asistente creó "Revisar servidor mañana" (tag `tareas`) con auditoría `Asistente`, y la nota de prueba fue eliminada por el operador.
- La OpenRouter key quedó en el vault (BYOK) validada contra la API real; hermes-u1 conserva su copia en `.env` hasta que Fase 7 la inyecte desde el vault. La UI de configuración llega en Fase 8.

**Criterio de hecho**: "Créame una nota para revisar el servidor mañana" crea una nota visible en la web. → ✅ verificado en producción.

---

## 9. Fase 7 — Assistant API + provisioning por usuario (rama `feat/assistant-api`)

- [x] Endpoint `POST /api/assistant/chat` con **streaming SSE** (usar `X-Accel-Buffering: no`, patrón de `server/index.js:441-476`).
- [x] Router por usuario → instancia Hermes del usuario:
  - [x] Arranque on-demand (contenedor apagado por idle-stop) + health check antes de reenviar.
  - [x] Reenvío al API server OpenAI-compatible de su instancia (`/v1/chat/completions`), con streaming.
  - [x] Idle-stop tras ~15 min sin uso (obligatorio para RAM del VPS con 2-3 usuarios).
- [x] Si el usuario no tiene API key configurada → `409` con CTA a configurarla (nunca error críptico).
- [x] Límites por usuario (rate limit propio, tamaño de mensaje) y errores genéricos hacia el cliente.
- [x] Nunca loggear keys ni credenciales; jamás exponerlas al navegador.
- [x] Retirar el asistente local:
  - [x] Eliminar bloque `server/index.js:1268-1350`.
  - [x] Reemplazar/eliminar `src/ai.js`.
  - [x] Quitar `@huggingface/transformers` del `package.json` y del Dockerfile.
  - [x] Borrar `~/.glass-keep/ai-cache` (libera ~1.6 GB de disco).
- [x] Convertir `localAiEnabled` (flag de navegador, `src/App.jsx:3363`) en configuración server-side.
- [x] Test de aislamiento: el chat del usuario A no ve notas del usuario B (misma batería que el smoke del MCP).

**✅ Completada el 2026-09-30** — commits `3e304b8`, `611516d`; imágenes `assistant-20260930`/`-20260930b`; backup previo `notes-20260930-101730.db`. Notas:
- **Waker service** (`deploy/hermes-waker/`, systemd, Python stdlib): arranca/apaga `hermes-u<id>` on-demand; la app lo llama por `host.docker.internal:8099` con Bearer token. Se agregó regla ufw `allow from 172.25.0.0/16 to port 8099` (ufw bloqueaba el tráfico app→host).
- Red Docker `indigo-assistant`: la app y `hermes-u1` se comunican por nombre (`http://hermes-u1:8642`), sin puertos publicados para el chat.
- Vault extendido con `hermes_key_enc` (API key del API server de Hermes, cifrada); `GET /api/assistant/status` expone `enabled`/`configured` por usuario.
- Smoke local **18/18** (mock Hermes + mock waker): 409 sin key LLM, 409 sin instancia, arranque on-demand, SSE con headers correctos, idle-stop y rearranque, validaciones 400/200.
- Producción: chat real **4s**; arranque on-demand desde apagado **30s** (24s boot + consulta); streaming verificado; UI valida con mock (búsqueda "Search or Ask AI..." se activa sola desde el server y renderiza la respuesta en vivo).
- Retiro del LLM local: imagen **795MB → 391MB**, `ai-cache` (1.6GB) eliminado, disco VPS 92% → **82%**; `npm audit` global: **0 vulnerabilidades**.
- Fix de UI: la disponibilidad del asistente ahora depende de `localAiHidden` (flag explícito del usuario) en vez de `localAiEnabled` (que el efecto de persistencia escribía como `false` antes de llegar el status). Importante: los usuarios con la PWA pueden necesitar un refresh para tomar el nuevo bundle (autoUpdate del service worker).

**Criterio de hecho**: chat con streaming funcionando con respuestas basadas en las notas propias; cero dependencias de LLM en el contenedor web; disco liberado. → ✅ (prod con 1 usuario configurado; aislamiento multi-usuario verificado en local con mocks y a nivel MCP con 2 usuarios).

---

## 10. Fase 8 — Chat UI "🤖 Asistente" + settings BYOK (rama `feat/chat-ui`)

- [ ] Nuevo componente en archivo propio: `src/assistant/AssistantView.jsx` (no engordar `App.jsx`, ya tiene 7036 líneas).
- [ ] Ruta `#/assistant` usando el `navigate` existente (`src/App.jsx:3823`) + entrada en el menú de 3 puntos (`src/App.jsx:2596-2684`).
- [ ] Panel de configuración del asistente:
  - [ ] Pegar API key del LLM (OpenRouter o endpoint custom), validarla y guardarla (vía Fase 6).
  - [ ] Mostrar enmascarada + proveedor/modelo; rotar/revocar.
  - [ ] Estado del asistente (sin key / listo / instancia arrancando).
- [x] Historial de conversación: `localStorage` por usuario en esta fase (Fase 9 lo mueve a la DB). **Adelantado el 2026-09-30** (junto con Fase 7): `assistantHistory-<userId>` guarda los últimos 20 mensajes; se envían en cada request y el botón "limpiar respuesta" resetea el hilo.
- [ ] Manejo de errores: 401 con el flujo `auth-expired` (`src/App.jsx:4450-4476`), 409 sin key (CTA), timeouts y reintento.
- [ ] Claves i18n en `src/locales/en.json` y `es.json`.
- [ ] Prueba en móvil (PWA) y escritorio.

**Criterio de hecho**: conversación fluida con streaming dentro de la app, sin fugas de secretos; cualquier usuario configura su key y chatea con sus notas.

---

## 11. Fase 9 — Memoria y contexto (rama `feat/memory`)

- [ ] Tablas nuevas `assistant_conversations` y `assistant_messages` (migración idempotente, igual estilo que `server/index.js:127-179`).
- [ ] `get_context` con historial y notas relacionadas.
- [ ] Normalizar tags (case-insensitive; hoy conviven `fintrak`/`Fintrak`, `linux`/`Linux`) — por convención en el MCP, sin tocar la DB.
- [ ] Opcional: FTS5 de SQLite si `search_notes` se vuelve lento (hoy 260 notas, no hace falta).

**Criterio de hecho**: el asistente recuerda el hilo y usa los tags correctamente.

---

## 12. Fase 10 — Tareas y recordatorios (rama `feat/reminders`)

- [ ] Ejecutar el plan ya escrito: `docs/plans/2026-05-05-calendar-reminders-plan.md`.
- [ ] Columnas `reminder_at`, `reminder_enabled`, `reminder_sent_at` + worker + SSE.
- [ ] Herramienta `create_task(title, due_at)` en el MCP.
- [ ] "Recuérdame revisar el servidor mañana" con aviso in-app.

**Criterio de hecho**: recordatorio creado por el agente y notificado a la hora.

---

## 13. Reglas de oro (no negociables)

- [ ] Ningún secreto en el repositorio ni en el frontend (ni API keys del LLM, ni JWT_SECRET). Secretos de usuarios cifrados en reposo (AES-256-GCM) y jamás en logs.
- [ ] Hermes y el MCP **nunca** acceden a SQLite; solo a la API REST.
- [ ] El MCP usa el token del usuario autenticado; nunca un token admin global.
- [ ] **Un Hermes por usuario** (single-tenant): nunca compartir instancia/memoria entre usuarios; barrera = contenedor/HERMES_HOME.
- [ ] Ninguna operación destructiva sin confirmación explícita; `permanent=1` prohibido para el agente.
- [ ] Los cambios de esquema de la DB llegan a partir de Fase 6 (BYOK/credenciales) y Fase 9 (memoria), siempre con migraciones idempotentes.
- [ ] Una fase = una rama = un despliegue verificable + rollback listo.
- [ ] Antes de cada deploy: respaldo de DB y health check después.

---

## 14. Criterios de aceptación globales (al terminar)

- [ ] Los 7 hallazgos de seguridad cerrados y verificados en producción.
- [ ] Runtime Node 22 y dependencias al día con build reproducible.
- [ ] MCP con lectura y escritura, aislado por usuario, probado con Hermes.
- [ ] Chat "🤖 Asistente" en la UI con streaming y confirmación de acciones destructivas.
- [ ] API key del LLM solo en el servidor; LLM local eliminado (0 uso de RAM/CPU local).
- [ ] Disco del servidor por debajo del 80%.
- [ ] Backup automático de `notes.db` (hoy solo manual en `backups/`).

---

## 15. Referencias rápidas (archivos clave)

| Tema | Archivo |
|---|---|
| Backend completo | `server/index.js` (auth 214-264, notas 564-1048, admin 1051-1265, IA 1268-1350) |
| Esquema DB | `server/index.js:81-179` |
| Frontend completo | `src/App.jsx` (AI 2400-2771/3913-3935, tags/búsqueda 5548-5584, auth 4410-4476) |
| Cliente IA actual | `src/ai.js` |
| Despliegue | `Dockerfile`, `local_docker_run.sh`, `/etc/nginx/sites-enabled/notes.indigosteam.com.conf` |
| Plan de recordatorios | `docs/plans/2026-05-05-calendar-reminders-plan.md` |
| Auditoría completa | Conversación del 2026-09-30 (resumen en este documento, §0) |

---

*Última actualización: 2026-09-30. Fases 1-7 completadas (commits `546f3f1`→`611516d`); todo desplegado en producción y Fase 5-7 corriendo en el VPS (`hermes-u1` + waker). Mantener este documento actualizado al cerrar cada fase (marcar checkboxes y anotar fecha/commit del despliegue).*
