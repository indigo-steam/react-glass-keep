# Fase 2 — Vista de chat del asistente (`#/assistant`)

Fecha: 2026-10-13
Alcance: **Fase 2** de la evolución del asistente a interfaz conversacional.
Depende de Fase 1 (commit `e4c423a`): `src/assistant/*` con transporte SSE, modelo de
mensajes y `useAssistantChat`.

Sin cambios en backend, MCP, contrato del stream ni Google Calendar. Sin migraciones.
Sin dependencias nuevas.

---

## 1. Contexto

Hoy el asistente se usa desde la barra de búsqueda de notas: un toggle ✨ activa el
modo IA y la respuesta aparece en una tarjeta inline (`AssistantResponseCard`). Esta
fase introduce una **vista de chat dedicada** y **retira el modo IA de la barra de
búsqueda**.

## 2. Objetivos

- Nueva ruta `#/assistant` con una vista de chat completa (historial, composer,
  indicadores de ejecución).
- Aprovechar el modelo tipado ya existente (texto, reasoning, tool calls) sin tocar el
  backend ni el contrato del stream.
- Conservar la persistencia textual existente (`assistantHistory-<userId>`, 20 turnos)
  y **hidratar** la vista desde ahí al abrir.
- La barra de búsqueda de notas vuelve a ser **solo búsqueda** (sin IA).

## 3. No objetivos (fases posteriores)

- Tarjetas de resultados de herramientas (gate §2.3 — requiere decidir el payload).
- Persistencia en base de datos de conversaciones/mensajes (Fase 9).
- Tareas/recordatorios (Fase 10).
- Cambios en Hermes, MCP, backend o Google Calendar.

## 4. Decisiones (validadas con el usuario)

1. **Ubicación**: ruta dedicada `#/assistant` (pantalla completa) + entrada en el menú
   de 3 puntos.
2. **Acceso actual**: se **quita** el toggle ✨ y la tarjeta inline de la pantalla de
   notas. La barra de búsqueda es solo búsqueda. Todo el chat vive en `#/assistant`.
   El estado/credenciales BYOK siguen en Ajustes.
3. **Contenido por respuesta**: texto final + **chips de herramientas** (en curso/hecho)
   + **bloque plegable "Razonamiento"**.
4. **Historial al recargar**: se **hidrata** desde `localStorage` (texto). Se mantiene la
   misma clave y formato. Tools/reasoning no persisten entre sesiones.
5. **Sugerencias**: chips en el estado vacío que envían la pregunta.
6. **Toggle "IA local" de Ajustes**: se **elimina** (junto con `localAiEnabled`,
   `setLocalAiEnabled`, `localAiHidden` y su efecto). La IA está disponible cuando el
   asistente está configurado (`assistantAvailable`); el acceso es el menú → `#/assistant`.

## 5. Arquitectura

**Enfoque elegido**: `AssistantView` es dueña del estado (instancia
`useAssistantChat`), y solo se monta en `#/assistant`. Aislamiento limpio, menos
prop drilling, y el hook deja de vivir en `App`.

Alternativas descartadas: hook en `App` con props a la vista (estado siempre vivo,
más acoplamiento) y context provider (infra extra; se reevaluará en Fase 9).

```
App (routes)
 └─ #/assistant → AssistantView
      ├─ useAssistantChat({ userId, onError })   ← estado + streaming + persistencia
      ├─ MessageBubble[]                         ← texto + ToolChips + ReasoningBlock
      └─ Composer                                ← enviar / detener
```

## 6. Componentes

Todos en `src/assistant/`:

| Archivo | Responsabilidad |
| --- | --- |
| `AssistantView.jsx` | Contenedor de la vista: header, lista de mensajes, estados vacío/carga/error, composer. Instancia `useAssistantChat`. |
| `MessageBubble.jsx` | Burbuja usuario/asistente. Asistente: markdown, chips de herramientas, bloque plegable de razonamiento, estado de error. |
| `Composer.jsx` | Textarea auto-expandible. Enter envía, Shift+Enter salto de línea. Botón Enviar; botón **Detener** durante streaming (usa `cancel`). |
| `icons.jsx` | Añadir iconos necesarios (reusar `Sparkles`; icono de enviar/detener). |
| `messages.js` | Nuevo helper puro `historyToMessages(history)` para hidratar texto→mensajes. |

`renderMarkdown` (`src/markdown.js`) se reutiliza para el texto del asistente.
`MessageStatus`/`ToolStatus` del modelo gobiernan los estados visuales.

## 7. Flujo de datos

- **Montaje**: `useAssistantChat` carga `assistantHistory-<userId>` en `historyRef`
  (comportamiento actual) y `AssistantView` lo mapea con `historyToMessages` a la lista
  visible (una sola vez, marcado como ya hidratado).
- **Envío**: `send(question)` añade `user` + `assistant(streaming)`; los eventos
  (`delta`/`reasoning`/`tool`/`done`) actualizan el mensaje; el texto persistido se
  guarda igual que hoy.
- **Detener**: `cancel()` aborta; se conserva lo recibido y el mensaje pasa a `done`.
- **Limpiar**: `clearAll` (borra visible + persistencia) desde la vista.

## 8. Cambios en la pantalla de notas (`App.jsx` / `NotesUI`)

- Eliminar el toggle ✨ y `<AssistantResponseCard>` inline; quitar `aiResponse`,
  `isAiLoading`, `aiLoadingProgress`, `setAiResponse` y el `useAssistantChat` de `App`.
- Barra de búsqueda: placeholder y padding vuelven al modo solo-búsqueda (quitar
  `localAiEnabled`, `toggleAiMode`, `localAiHidden` y sus efectos).
- **Conservar** `assistantAvailable` (de `/assistant/status`) para gobernar la entrada
  del menú y la disponibilidad de la vista.
- `AssistantResponseCard.jsx` y sus usos inline se retiran (el archivo puede quedar sin
  uso; se documentará, sin borrar en esta fase salvo decisión explícita).

## 9. Routing

- Añadir `#/assistant` a las rutas permitidas (`App.jsx:7043`) y su rama de render.
- Requiere sesión iniciada; sin sesión → `#/login`.
- Entrada en el menú de 3 puntos: "Asistente" (icono `Sparkles`), visible cuando
  `assistantAvailable`.

## 10. UX

- **Estado vacío**: título + descripción + 3–4 chips de sugerencias (i18n) que envían la
  pregunta.
- **Streaming**: indicador "pensando" + barra de progreso; chips de herramientas
  actualizándose.
- **Errores**: burbuja de error. 409 sin key → CTA a Ajustes. 401 → flujo `auth-expired`
  existente. Timeouts/reintento: mensaje de error + permitir reenviar.
- **Responsive** (móvil PWA y escritorio), claro/oscuro, `glass-card`/tokens de estilo
  existentes.
- Composer fijo inferior.

## 11. i18n

Claves nuevas bajo `assistant.*` en `src/locales/es.json` y `en.json`: título,
placeholder, enviar, detener, limpiar, estado vacío (título/descripción), sugerencias
(3–4), razonamiento (etiqueta), herramientas (en curso/hecho), pensando, error genérico,
y `menu.assistant`.

## 12. Verificación

- `npm run build` PASS.
- `npx eslint src server mcp`: sin problemas nuevos (baseline 150 errores/10 warnings).
- `node test/assistant-stream.mjs`: extender con `historyToMessages` (casos: vacío,
  par user/assistant, recorte a 20) y mantener los 23 checks.
- Verificación manual en el stack local (`http://127.0.0.1:5173`, proxy `/api` → 8080):
  navegar a `#/assistant`, enviar, ver streaming/chips/razonamiento, recargar
  (hidratación), detener, limpiar, sugerencias, móvil y escritorio.
- Sin regresión: `server/test/calendar-manual.mjs` y `mcp/test/smoke.mjs` (el fallo
  "15 herramientas" sigue siendo preexistente).

## 13. Riesgos y decisiones abiertas

- **`AssistantResponseCard` sin uso** tras el cambio: se retira su uso; decidir si borrar
  el archivo o dejarlo (evitar cambios destructivos innecesarios).
- **Hidratación idempotente**: evitar duplicar mensajes si el componente re-monta
  (marcar como hidratado o hidratar solo en el estado inicial).
- **Payload de tools** (Fase 3) sigue abierto; el modelo ya lo captura, no bloquea.

## 14. Criterios de aceptación

- Existe `#/assistant` accesible desde el menú, con chat funcional (streaming, chips de
  herramientas y razonamiento plegable).
- La pantalla de notas ya no tiene modo IA ni tarjeta inline; su búsqueda es solo de
  notas.
- El historial se hidrata al recargar y se persiste con la misma clave/formato.
- Sugerencias, detener y limpiar funcionan.
- Build, eslint (sin nuevos), tests del asistente y regresión de Calendar/MCP OK.
- Sin cambios en backend, MCP, contrato del stream ni Calendar; sin dependencias nuevas.
