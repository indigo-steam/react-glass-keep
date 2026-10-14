# Fases 0 y 1 — Línea base y decisiones de arquitectura

Fecha: 2026-10-13
Alcance autorizado: **Fase 0** (preparación y pruebas de regresión) y **Fase 1** (refactorización del asistente).
Sin cambios en backend, MCP, contrato del stream ni Google Calendar. Sin migraciones de base de datos.

---

## 1. Fase 0 — Línea base del comportamiento previo

Entorno: `node v22.22.1`, `npm 9.2.0`, `main` en `30c7021`, árbol limpio.

### 1.1 Resultados (antes de los cambios)

| Prueba | Comando | Resultado |
| --- | --- | --- |
| Build de producción | `npm run build` | ✅ PASS (exit 0) |
| ESLint | `npx eslint src server mcp` | ❌ 151 errores / 10 warnings (preexistente) |
| Backend + Calendar (manual) | `node server/test/calendar-manual.mjs` | ✅ PASS (10/10) |
| MCP (smoke) | `node mcp/test/smoke.mjs` | ❌ FAIL (1) — **preexistente**, 27 `ok` |

Entorno de prueba: servidor local aislado en `127.0.0.1:8096` con DB temporal y `ALLOW_REGISTRATION=true`.

### 1.2 Fallos preexistentes (documentados, no regresiones)

- **ESLint**: 151 errores / 10 warnings, concentrados en `src/App.jsx` (92/9), `server/index.js` (53), `mcp/index.js` (6), `src/DrawingCanvas.jsx` (0/1). Son mayormente `no-unused-vars` y `no-empty`. Se usan como línea base: el criterio de aceptación es **no introducir problemas nuevos**, no llegar a cero.
- **MCP smoke**: la aserción `expone las 15 herramientas` falla porque el MCP expone 18 (se agregaron `create_birthday_event`, `update_calendar_event`, `delete_calendar_event`). **No se corrigió** porque la restricción prohíbe modificar MCP en esta fase. Las 27 comprobaciones funcionales restantes pasan.

### 1.3 Referencia del asistente actual

- Contrato `/api/assistant/chat` (proxy SSE crudo hacia Hermes): 409 sin key, 503 si Hermes no está disponible, 400 si el último mensaje no es del usuario, rate limit 20/5min.
- El stream transporta: chunks OpenAI (`choices[0].delta.content`), `delta.reasoning_content`, y eventos con nombre `event: hermes.tool.progress` (`{tool, emoji, label, toolCallId, status:"running"|"completed"}`). **No** transporta el payload/resultado de las herramientas.
- El cliente previo (`src/ai.js`) sólo parseaba líneas `data:` y `choices[0].delta.content`; **descartaba** los eventos `event:` (tool progress) y `reasoning_content`.
- Historial: sólo en `localStorage["assistantHistory-<userId>"]`, máx 20 turnos `{role, content}`, enviado como contexto pero no renderizado.

---

## 2. Decisiones de arquitectura (condicionan las fases siguientes)

### 2.1 Modelo de conversación

Mensajes como objetos planos (documentados con JSDoc en `src/assistant/messages.js`):

- `UserMessage`: `{ id, role:'user', content, createdAt }`
- `AssistantMessage`: `{ id, role:'assistant', content, reasoning, status:'streaming'|'done'|'error', tools: ToolCall[], error, createdAt }`
- `ToolCall`: `{ toolCallId, tool, label, emoji, status, startedAt, endedAt }`

El estado de procesamiento es `AssistantMessage.status`. Los errores se capturan en `status:'error'` + `error`. Las llamadas a herramientas se acumulan en `tools`, **deduplicadas por `toolCallId`** (reintentos actualizan la misma entrada en lugar de duplicarla).

El orden lo da el array `messages`. El stream se traduce a eventos tipados (`start`, `reasoning`, `delta`, `tool`, `finish`, `done`, `error`, `unknown`) en `src/assistant/sse.js` + `src/assistant/stream.js`.

### 2.2 Persistencia

- **Qué se conserva hoy**: sólo el contexto textual en `localStorage["assistantHistory-<userId>"]` (máx 20 turnos, `{role, content}`). Es lo que se envía al backend.
- **Qué se pierde al recargar**: la lista tipada de mensajes de la sesión (tool calls, reasoning, marcas de tiempo) — igual que antes del refactor, donde nada de eso se guardaba.
- **Decisión**: **no** se agrega persistencia nueva. El hook persiste exactamente el mismo contrato textual que antes (misma clave, mismo shape, mismo tope de 20). La lista tipada vive en memoria de sesión; una vista de chat podrá hidratarla en el futuro sin cambiar el contrato actual.

### 2.3 Tarjetas de resultados

Dado que el stream **no** transporta el payload de las herramientas, las alternativas son:

1. **Mantener respuestas textuales** (lo actual): el modelo ya permite, pero muestra el texto final del agente.
2. **Enriquecer el contrato del stream** (fase futura, requiere tocar backend/Hermes): que las tool responses viajen en el stream.
3. **Re-consultar tras `completed`** vía endpoints ya existentes: el backend ya tiene los datos (notas/eventos); el frontend podría pedirlos.

**Decisión**: no se implementa nada de esto en Fase 1. El modelo de mensajes ya guarda cada `ToolCall` con `toolCallId` y estado, de modo que cualquiera de las tres alternativas se puede conectar después **sin reconstruir el chat**. Se deja como decisión abierta para Fase 3.

### 2.4 Interfaz objetivo

Vista de chat con historial de mensajes, compositor fijo inferior, indicadores de ejecución y diseño adaptable, **conservando** la sección tradicional de notas. En Fase 1 **no** se implementa: se preserva la tarjeta de respuesta actual (`src/assistant/AssistantResponseCard.jsx`) para no alterar el comportamiento, y se prepara la arquitectura (hook + modelo) para que la vista la consuma.

### 2.5 Compatibilidad

- `src/ai.js` se mantiene como fachada: re-exporta `streamAssistant`/`STREAM_EVENT` y conserva `askAI` (delegando) e `initAI`, con la **misma semántica** del `onProgress` legado (`text` acumulado).
- Los nombres de props de `NotesUI` referidos al asistente (`aiResponse`, `setAiResponse`, `isAiLoading`, `aiLoadingProgress`, `onAiSearch`, `onClearAiHistory`, `assistantAvailable`, `onToggleAiMode`) se conservaron para minimizar el diff.
- El hook usa `AbortController` y aborta el stream al desmontar; los updaters de estado son puros (seguro con `StrictMode`).

---

## 3. Fase 1 — Implementación

### 3.1 Archivos nuevos

| Archivo | Responsabilidad |
| --- | --- |
| `src/markdown.js` | `renderMarkdown` extraído de `App.jsx` (misma sanitización). |
| `src/assistant/sse.js` | Parser SSE puro + interpretación de frames (OpenAI + Hermes). Sin i18n/React/APIs de navegador → testeable en Node. |
| `src/assistant/messages.js` | Modelo tipado de mensajes + helpers puros (`createUserMessage`, `createAssistantMessage`, `appendDelta`, `appendReasoning`, `normalizeTool`, `upsertTool`, `lastAssistantMessage`). |
| `src/assistant/stream.js` | Transporte: `fetch` + auth + eventos tipados (`streamAssistant`). |
| `src/assistant/useAssistantChat.js` | Hook React: estado de mensajes, streaming, persistencia del contexto, cancelación. |
| `src/assistant/AssistantResponseCard.jsx` | Tarjeta de respuesta extraída (markup idéntico al previo). |
| `src/assistant/icons.jsx` | `Sparkles` y `CloseIcon` extraídos de `App.jsx` (verbatim). |
| `test/assistant-stream.mjs` | Pruebas Node de los módulos puros (23 comprobaciones). |

### 3.2 Archivos modificados

- `src/ai.js`: fachada delgada (un solo parser, sin duplicación); `askAI` delegando a `streamAssistant`.
- `src/App.jsx`: se eliminó el estado local del asistente (`aiResponse`, `isAiLoading`, `aiLoadingProgress`, `aiHistory`) y `handleAiSearch`; ahora usa `useAssistantChat` y deriva los valores de compatibilidad. Se eliminaron las definiciones locales de `renderMarkdown`, `CloseIcon`, `Sparkles` (ahora importadas). La tarjeta inline se reemplazó por `<AssistantResponseCard />`.

### 3.3 Qué NO se hizo (fuera de alcance)

- No se implementó la vista conversacional completa ni las tarjetas de resultados.
- No se modificó backend, MCP, el contrato del stream ni Google Calendar.
- No se agregaron dependencias ni migraciones.
- Los eventos de herramientas **se capturan en el modelo** pero **no se visualizan** todavía (Fase 2).

---

## 4. Verificación

### 4.1 Estática

- `npm run build` → ✅ PASS.
- `npx eslint src server mcp` → 150 errores / 10 warnings (línea base 151/10). **Sin problemas nuevos**; se eliminó 1 error preexistente (`'e' is defined but never used`).

### 4.2 Pruebas unitarias (nuevas)

`node test/assistant-stream.mjs` → ✅ **23/23 PASS**. Cubre: parser SSE con chunks partidos, tool progress (running/completed), reasoning, deltas de contenido, `finish_reason`, `[DONE]`, eventos desconocidos, JSON malformado, y el modelo (dedup por `toolCallId`, timestamps, aliases).

### 4.3 E2E en navegador real (Playwright, backend mockeado)

Flujo completo sobre el build de producción servido por el propio backend:
registro → modo IA activo → envío → stream SSE con `hermes.tool.progress` + `reasoning_content` + delta → render.

- Respuesta renderizada: `<p>Encontré <strong>3</strong> notas (prueba E2E).</p>` ✅
- **0 errores de consola, 0 errores de página** ✅
- El 2.º turno envía el contexto `[{user},{assistant},{user}]` al backend (contrato legado) ✅
- Persistencia: `assistantHistory-<userId>` = `[{user:'…'},{assistant:'…'}]` ✅
- Botón limpiar: tarjeta oculta e historial a `[]` ✅

### 4.4 Regresión (backend/MCP, sin cambios)

- `server/test/calendar-manual.mjs` → ✅ PASS (10/10).
- `mcp/test/smoke.mjs` → 27 `ok` / 1 FAIL (el mismo preexistente "15 herramientas"). Sin regresión.

---

## 5. Riesgos y decisiones abiertas

1. **Payload de herramientas**: las tarjetas de resultados (Fase 3) dependen de elegir entre mantener texto, enriquecer el stream o re-consultar (decisión §2.3). No bloquea Fase 1.
2. **Test MCP desactualizado**: `mcp/test/smoke.mjs` espera 15 tools y hay 18. Corregirlo requiere tocar MCP (prohibido en Fase 0). Queda pendiente.
3. **ESLint preexistente**: 150 errores. No se abordan en estas fases para no mezclar refactor con limpieza.
4. **`askAI`/`initAI`**: se conservan como compatibilidad aunque hoy nadie los importe; pueden retirarse cuando se confirme que no hay consumidores externos.
