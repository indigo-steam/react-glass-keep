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
```
Usuario → Glass Keep Web UI → Assistant API → Hermes → Cloud LLM
                                                    ↓
                                            GlassKeep MCP → Glass Keep API → SQLite
```

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

- [ ] Usar Context7 para consultar APIs actuales antes de tocar cada librería
  (herramientas `resolve-library-id` y `query-docs`; por ejemplo: "Express 5
  migration guide", "better-sqlite3 latest API").
- [ ] Subir el runtime del `Dockerfile` de `node:18-slim` a `node:22-slim` (LTS).
- [ ] Revisar/actualizar una por una, con build + smoke test entre cada una:
  - [ ] `better-sqlite3` (nativa: verificar rebuild en arm64 dentro de Docker)
  - [ ] `express` 4 → 5 (revisar sintaxis de rutas `*` en el fallback SPA, `server/index.js:1359`)
  - [ ] `bcryptjs`, `jsonwebtoken`, `cors`
  - [ ] Grupo Vite/React/Tailwind (solo si hay motivo; ya están recientes)
- [ ] Quitar del `Dockerfile` los pasos heredados de `sharp`/`libvips` si ya no se usan.
- [ ] Construir imagen y medir tamaño/consumo; anotar antes/después.

**Criterio de hecho**: imagen construida en Node 22, app funcionando igual, sin warnings de dependencias nativas.

---

## 6. Fase 4 — MCP solo lectura (rama `feat/mcp-readonly`)

**Objetivo**: primer MCP contra la API existente. **Sin cambios de base de datos.**
Puede construirse contra `GET /api/notes` sin tocar el backend.

- [ ] Crear carpeta `mcp/` con su `package.json` (no mezclar con el frontend).
- [ ] Decorar herramientas mínimas:
  - [ ] `search_notes(query?, tags?[], include_archived?, limit=20)`
  - [ ] `get_note(id)`
  - [ ] `list_tags()`
  - [ ] `get_context(note_id?, query?, max_notes=10)`
- [ ] Credencial del MCP: por ahora `POST /api/login/secret` (existe) para obtener
  JWT; documentar que en Fase 6 se añadirá `POST /api/api-keys` por usuario.
- [ ] Probar con MCP Inspector: buscar "moto", "Fintrak", "SENA" y verificar que
  devuelve solo notas del usuario autenticado.
- [ ] Opcional backend (mejora, no bloqueante): `GET /api/notes/:id` y
  `GET /api/notes?tag=` para evitar traer todo.

**Criterio de hecho**: el MCP lista y lee notas reales sin acceso a SQLite y sin ver datos de otro usuario.

---

## 7. Fase 5 — Pruebas con Hermes (rama/config `feat/hermes`)

- [ ] Definir cómo consume Hermes el MCP (`stdio` si es local; HTTP si es contenedor).
- [ ] Configurar Hermes con la API key del LLM **solo en su entorno** (nunca en frontend ni en el repo).
- [ ] Pruebas read-only:
  - [ ] "¿Qué tengo pendiente relacionado con SENA?"
  - [ ] "Busca mis notas de Fintrak"
  - [ ] "Busca la nota del cambio de aceite de la moto"
- [ ] Medir consumo de Hermes + MCP en el servidor (1 vCPU / 2.7 GB): CPU, RAM, disco.
- [ ] Documentar resultados en `docs/`.

**Criterio de hecho**: respuestas correctas citando notas reales; consumo medido y aceptable.

---

## 8. Fase 6 — MCP escritura (rama `feat/mcp-write`)

- [ ] Herramientas:
  - [ ] `create_note(title, content?, tags?, type?, items?)` → `POST /api/notes`
  - [ ] `update_note(id, cambios)` → `PATCH /api/notes/:id` (nunca `PUT`; siempre leer antes de escribir)
  - [ ] `archive_note(id, archived)` → `POST /api/notes/:id/archive`
  - [ ] `restore_note(id)` → `POST /api/notes/:id/restore`
  - [ ] `delete_note(id, confirm:true)` → `DELETE /api/notes/:id` (jamás `permanent=1`)
- [ ] Decidir identidad/auditoría del agente (hoy `last_edited_by` es texto libre,
  `server/index.js:690`): usuario bot colaborador **o** marcador `"Asistente"`.
- [ ] Confirmación obligatoria para operaciones destructivas (diálogo en UI o flag `confirm`).
- [ ] Añadir `POST /api/api-keys` (clave por usuario, hasheada, revocable, scopes read/write) si no se hizo antes.
- [ ] Pruebas de aislamiento: token del usuario A no puede leer/editar notas del usuario B (salvo colaboración explícita).

**Criterio de hecho**: "Créame una nota para revisar el servidor mañana" crea una nota visible en la web.

---

## 9. Fase 7 — Assistant API y retirada del LLM local (rama `feat/assistant-api`)

- [ ] Endpoint `POST /api/assistant/chat` con **streaming SSE** (usar `X-Accel-Buffering: no`, patrón de `server/index.js:441-476`).
- [ ] La Assistant API resuelve el token MCP del usuario y llama a Hermes; el navegador nunca ve la API key.
- [ ] Retirar el asistente local:
  - [ ] Eliminar bloque `server/index.js:1268-1350`.
  - [ ] Reemplazar/eliminar `src/ai.js`.
  - [ ] Quitar `@huggingface/transformers` del `package.json` y del Dockerfile.
  - [ ] Borrar `~/.glass-keep/ai-cache` (libera 1.6 GB de disco).
- [ ] Convertir `localAiEnabled` (flag de navegador, `src/App.jsx:3363`) en configuración server-side.

**Criterio de hecho**: chat con streaming funcionando; cero dependencias de LLM en el contenedor web; disco liberado.

---

## 10. Fase 8 — Chat UI "🤖 Asistente" (rama `feat/chat-ui`)

- [ ] Nuevo componente en archivo propio: `src/assistant/AssistantView.jsx` (no engordar `App.jsx`, ya tiene 7036 líneas).
- [ ] Ruta `#/assistant` usando el `navigate` existente (`src/App.jsx:3823`) + entrada en el menú de 3 puntos (`src/App.jsx:2596-2684`).
- [ ] Historial de conversación en Fase 1: `localStorage` por usuario.
- [ ] Manejo de errores: 401 con el flujo `auth-expired` (`src/App.jsx:4450-4476`), timeouts y reintento.
- [ ] Claves i18n en `src/locales/en.json` y `es.json`.
- [ ] Prueba en móvil (PWA) y escritorio.

**Criterio de hecho**: conversación fluida con streaming dentro de la app, sin fugas de secretos.

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

- [ ] Ningún secreto en el repositorio ni en el frontend (ni API keys del LLM, ni JWT_SECRET).
- [ ] Hermes y el MCP **nunca** acceden a SQLite; solo a la API REST.
- [ ] El MCP usa el token del usuario autenticado; nunca un token admin global.
- [ ] Ninguna operación destructiva sin confirmación explícita; `permanent=1` prohibido para el agente.
- [ ] Ningún cambio de esquema de la DB hasta Fase 9; antes se usan tags/convenciones.
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

*Última actualización: 2026-09-30. Fases 1 y 2 completadas y desplegadas (commits `546f3f1`→`b8a0925`, imagen `indigo-notes:security-20260930`). Mantener este documento actualizado al cerrar cada fase (marcar checkboxes y anotar fecha/commit del despliegue).*
