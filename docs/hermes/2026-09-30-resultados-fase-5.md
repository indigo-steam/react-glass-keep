# Fase 5 — Hermes base + instancia del dueño (resultados)

Fecha: 2026-09-30
Plan: `docs/plans/2026-09-30-plan-trabajo-local-seguridad-mcp.md` (§7)
Estado: **completada** — respuestas correctas citando notas reales; consumo medido.

## Arquitectura implementada

```
Usuario → (Fase 7: Assistant API) → Hermes u1 (contenedor) → OpenRouter (gemini-3-flash)
                                        └─ MCP glasskeep (stdio) → https://notes.indigosteam.com
```

- **Imagen oficial**: `nousresearch/hermes-agent:latest` (v0.21.5, digest `sha256:d4da4a40…`) — incluye Node 26, por eso corre nuestro MCP stdio sin instalar nada extra.
- **Un contenedor por usuario**: `hermes-u1` → `/home/ubuntu/hermes-users/1` montado en `/opt/data` (`HERMES_HOME` propio).
- **MCP montado read-only**: `/home/ubuntu/indigo-notes/mcp → /opt/mcp:ro` (con `node_modules` instalados con `node:22-slim` + `npm ci`).
- **API server OpenAI-compatible**: `127.0.0.1:8643 → 8642` (`API_SERVER_ENABLED/KEY/HOST` en `/opt/data/.env`; la key también en `/opt/data/.api_server_key`, legible solo vía `docker exec`/sudo).
- **Modelo**: `openrouter` + `google/gemini-3-flash-preview`.
- **Toolsets restringidos**: `platform_toolsets.api_server: []` → **0 tools built-in** (sin terminal, file, browser, web). El agente solo tiene las 4 tools del MCP.
- **Límites del contenedor**: `--memory 1200m` (reposo real ~270 MB).

## Configuración del MCP en Hermes

```bash
docker exec hermes-u1 hermes mcp add glasskeep --command node \
  --env GLASSKEEP_URL=https://notes.indigosteam.com GLASSKEEP_TOKEN=<credencial> \
  --args /opt/mcp/index.js
```

- Credencial actual: **JWT temporal de 365 días** firmado dentro del contenedor `indigo-notes` (uid 1, admin). *Pendiente*: reemplazar por la secret key del usuario o por `POST /api/api-keys` (Fase 6).
- `hermes mcp test glasskeep` → conectado en ~2.5 s, 4 tools descubiertas.

## Verificación (criterio de hecho)

| Consulta | Resultado | Tiempo |
|---|---|---|
| "¿Qué tengo pendiente relacionado con SENA?" | Correcta: evidencias GA3/GA4, enviadas sin calificar, script de PDF | 33 s |
| "Busca mis notas de Fintrak" | Correcta: 10 notas con fechas y tags | <60 s |
| "Busca la nota del cambio de aceite de la moto" | Correcta: "cambio a los 68.900 km" | <60 s |
| Streaming SSE (`stream:true`) | `chat.completion.chunk` estándar ✅ | ~3 s |

## Mediciones (VPS 1 vCPU / 5.8 GB)

| Métrica | Valor |
|---|---|
| Arranque del contenedor hasta `/health` ok | **21 s** |
| RAM en reposo (gateway + s6) | ~270–300 MB |
| RAM tras consultas | ~337 MB |
| CPU en reposo | <0.5 % |
| Imagen Hermes | 2.69 GB |
| `HERMES_HOME` por usuario | 75 MB |
| Disco VPS | 3.9 GB libres (92 %) ⚠️ |

## Hallazgos y pendientes

1. **`queries` vs `query`**: el modelo intentó `search_notes({queries:[...]})` y el schema lo rechazó ("additionalProperties"); reintentó y respondió bien. → Mejora para Fase 6: aceptar alias `queries` (string o array) en el MCP.
2. **Warning de Hermes**: API server en `0.0.0.0` dentro del contenedor con backend `terminal: local`. Mitigado: puerto publicado solo en `127.0.0.1` y toolset terminal **deshabilitado** (`platform_toolsets.api_server: []`).
3. **Disco al 92 %**: la limpieza de `~/.glass-keep/ai-cache` (1.6 GB, Fase 7) es importante; monitorear.
4. **Credencial temporal**: el JWT de 365 días no es revocable individualmente; Fase 6 (`api-keys`) lo reemplaza. La OpenRouter key cargada es temporal (reemplazada por la UI BYOK en Fase 6/8).
5. **Idle-stop (Fase 7)**: con ~300 MB por instancia, 2-3 usuarios caben aplicando apagado por inactividad (`docker stop`/`start` + health check antes de reenviar).

## Comandos útiles (operación)

```bash
# Estado
docker ps --filter name=hermes-u1
docker exec hermes-u1 hermes mcp list
docker exec hermes-u1 hermes config get platform_toolsets

# Consulta directa al API server
KEY=$(docker exec hermes-u1 cat /opt/data/.api_server_key)
curl -s -X POST http://127.0.0.1:8643/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"..."}]}'

# Actualizar imagen (documentar antes/después de versión)
docker pull nousresearch/hermes-agent:latest && docker rm -f hermes-u1 && \
docker run -d --name hermes-u1 --restart unless-stopped -p 127.0.0.1:8643:8642 \
  --memory 1200m -v /home/ubuntu/hermes-users/1:/opt/data \
  -v /home/ubuntu/indigo-notes/mcp:/opt/mcp:ro \
  nousresearch/hermes-agent:latest gateway run
```
