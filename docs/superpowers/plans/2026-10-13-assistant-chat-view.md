# Vista de chat del asistente (`#/assistant`) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir una vista de chat dedicada en `#/assistant` y retirar el modo IA de la pantalla de notas, reutilizando el transporte SSE y el modelo ya existentes.

**Architecture:** `AssistantView` (dueña del estado) instancia `useAssistantChat` y renderiza `MessageBubble[]` + `Composer`. La ruta se añade al router por hash existente. La pantalla de notas pierde el toggle ✨, la tarjeta inline y el toggle "IA local" de Ajustes.

**Tech Stack:** React 18 (StrictMode), Vite, Tailwind, `marked`+`dompurify`, React i18next, hash routing manual. Tests Node puros (`node test/assistant-stream.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-13-assistant-chat-view-design.md`

## File Structure

- Create `src/assistant/AssistantView.jsx` — contenedor de la vista (header, lista, estados, composer).
- Create `src/assistant/MessageBubble.jsx` — burbuja usuario/asistente + chips de tools + razonamiento.
- Create `src/assistant/Composer.jsx` — textarea + enviar/detener.
- Modify `src/assistant/icons.jsx` — añadir `SendIcon`, `StopIcon`.
- Modify `src/assistant/messages.js` — añadir `historyToMessages`.
- Modify `src/assistant/useAssistantChat.js` — opción `hydrate` (sembrar mensajes desde localStorage).
- Modify `test/assistant-stream.mjs` — tests de `historyToMessages`.
- Modify `src/App.jsx` — ruta `#/assistant`, entrada de menú, y eliminación del modo IA de notas.
- Modify `src/locales/es.json`, `src/locales/en.json` — claves `assistant.*`.

Notas de estilo: los CSS vars (`--bg-light`, `--card-bg-light`, `--text-light`, `--border-light`) se remapean bajo `html.dark`, así que son theme-aware.

---

### Task 1: Helper puro `historyToMessages`

**Files:**
- Modify: `src/assistant/messages.js`
- Test: `test/assistant-stream.mjs`

- [ ] **Step 1: Write the failing test**

En `test/assistant-stream.mjs`, añade `historyToMessages` al import de `../src/assistant/messages.js`:

```js
import {
  MessageStatus,
  ToolStatus,
  appendDelta,
  appendReasoning,
  createAssistantMessage,
  createUserMessage,
  historyToMessages,
  lastAssistantMessage,
  normalizeTool,
  upsertTool,
} from "../src/assistant/messages.js";
```

Y añade este bloque justo antes del bloque final `if (failures === 0)`:

```js
{
  const empty = historyToMessages([]);
  check("historyToMessages vacío -> []", Array.isArray(empty) && empty.length === 0);

  const parsed = historyToMessages([
    { role: "user", content: "hola" },
    { role: "assistant", content: "¿en qué te ayudo?" },
  ]);
  check(
    "historyToMessages mapea roles",
    parsed.length === 2 && parsed[0].role === "user" && parsed[1].role === "assistant"
  );
  check(
    "historyToMessages assistant queda done con contenido",
    parsed[1].status === MessageStatus.DONE && parsed[1].content === "¿en qué te ayudo?"
  );

  const filtered = historyToMessages([
    { role: "system", content: "x" },
    { role: "user" },
    null,
  ]);
  check("historyToMessages ignora entradas inválidas", filtered.length === 0);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/assistant-stream.mjs`
Expected: FAIL con `historyToMessages is not a function` (o error de import).

- [ ] **Step 3: Write minimal implementation**

En `src/assistant/messages.js`, al final del archivo, añade:

```js
/**
 * Rebuild a visible message list from the persisted text-only history
 * (`[{ role:'user'|'assistant', content }]`). Pure: no storage access here.
 */
export function historyToMessages(history) {
  const list = Array.isArray(history) ? history : [];
  return list
    .filter(
      (t) =>
        t &&
        (t.role === "user" || t.role === "assistant") &&
        typeof t.content === "string"
    )
    .map((t) =>
      t.role === "user"
        ? createUserMessage(t.content)
        : { ...createAssistantMessage(), content: t.content, status: MessageStatus.DONE }
    );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/assistant-stream.mjs`
Expected: PASS (27 checks) y `ASSISTANT STREAM TEST: PASS`.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/messages.js test/assistant-stream.mjs
git commit -m "feat(assistant): historyToMessages helper + tests"
```

---

### Task 2: Claves i18n `assistant.*`

**Files:**
- Modify: `src/locales/es.json`
- Modify: `src/locales/en.json`

- [ ] **Step 1: Añadir en `src/locales/es.json`**

Dentro del objeto `menu`, añade la clave `assistant`:

```json
"menu": {
  "open": "Menú",
  "assistant": "Asistente",
  "signOut": "Cerrar sesión"
}
```

Añade un objeto `assistant` de nivel superior (junto a `ai`):

```json
"assistant": {
  "title": "Asistente",
  "placeholder": "Escribe un mensaje…",
  "send": "Enviar",
  "stop": "Detener",
  "clear": "Limpiar conversación",
  "reasoning": "Razonamiento",
  "emptyTitle": "¿En qué te ayudo?",
  "emptyHint": "Pregúntame sobre tus notas, tu calendario o pídeme que organice algo.",
  "notConfigured": "El asistente no está configurado. Agrega tu clave de API en Ajustes.",
  "suggestions": {
    "notes": "Resume mis notas de esta semana",
    "calendar": "¿Qué tengo en el calendario mañana?",
    "summary": "¿Qué notas tengo pendientes?",
    "organize": "Ayúdame a organizar mis tags"
  }
}
```

- [ ] **Step 2: Añadir en `src/locales/en.json`** (equivalente en inglés)

```json
"menu": {
  "open": "Menu",
  "assistant": "Assistant",
  "signOut": "Sign out"
}
```

```json
"assistant": {
  "title": "Assistant",
  "placeholder": "Type a message…",
  "send": "Send",
  "stop": "Stop",
  "clear": "Clear conversation",
  "reasoning": "Reasoning",
  "emptyTitle": "How can I help?",
  "emptyHint": "Ask me about your notes, your calendar, or ask me to organize something.",
  "notConfigured": "The assistant is not configured. Add your API key in Settings.",
  "suggestions": {
    "notes": "Summarize my notes from this week",
    "calendar": "What's on my calendar tomorrow?",
    "summary": "Which notes are pending?",
    "organize": "Help me organize my tags"
  }
}
```

- [ ] **Step 3: Verificar JSON válido**

Run: `node -e "require('./src/locales/es.json'); require('./src/locales/en.json'); console.log('json ok')"`
Expected: `json ok`

- [ ] **Step 4: Commit**

```bash
git add src/locales/es.json src/locales/en.json
git commit -m "feat(i18n): assistant view keys (es/en)"
```

---

### Task 3: Iconos `SendIcon` y `StopIcon`

**Files:**
- Modify: `src/assistant/icons.jsx`

- [ ] **Step 1: Añadir los iconos**

Añade al final de `src/assistant/icons.jsx`:

```jsx
export const SendIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="m22 2-7 20-4-9-9-4Z" />
    <path d="M22 2 11 13" />
  </svg>
);

export const StopIcon = () => (
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
  </svg>
);
```

- [ ] **Step 2: Verificar que compila**

Run: `npm run build 2>&1 | tail -3`
Expected: `✓ built in` sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/assistant/icons.jsx
git commit -m "feat(assistant): send/stop icons"
```

---

### Task 4: Hidratar la conversación en `useAssistantChat`

**Files:**
- Modify: `src/assistant/useAssistantChat.js`

- [ ] **Step 1: Importar el helper y añadir `loadStoredHistory`**

En `src/assistant/useAssistantChat.js`, añade `historyToMessages` al import de `./messages`:

```js
import {
  MessageStatus,
  appendDelta,
  appendReasoning,
  createAssistantMessage,
  createUserMessage,
  historyToMessages,
  normalizeTool,
  upsertTool,
} from "./messages";
```

Y justo debajo de `const HISTORY_LIMIT = 20;`, añade:

```js
// Read the persisted text-only history (null-safe, never throws).
function loadStoredHistory(storageKey) {
  if (!storageKey) return [];
  try {
    const raw = localStorage.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
```

- [ ] **Step 2: Añadir la opción `hydrate` y sembrar `messages`**

Cambia la firma y la inicialización de `messages`:

```js
export function useAssistantChat({ userId, onError, hydrate = true } = {}) {
  const storageKey = userId ? `assistantHistory-${userId}` : null;

  const [messages, setMessages] = useState(() =>
    hydrate ? historyToMessages(loadStoredHistory(storageKey)) : []
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [progress, setProgress] = useState(null);
```

- [ ] **Step 3: Re-sembrar al cambiar de usuario**

Reemplaza el `useEffect` que hoy sólo carga `historyRef` (el que empieza con `if (!storageKey)`) por:

```js
  const seededKeyRef = useRef(storageKey);

  useEffect(() => {
    const stored = loadStoredHistory(storageKey);
    historyRef.current = stored;
    if (storageKey !== seededKeyRef.current) {
      seededKeyRef.current = storageKey;
      if (hydrate) setMessages(historyToMessages(stored));
    }
  }, [storageKey, hydrate]);
```

(Asegúrate de que `useRef` ya esté importado — ya lo está.)

- [ ] **Step 4: Verificar build**

Run: `npm run build 2>&1 | tail -3`
Expected: `✓ built in` sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/assistant/useAssistantChat.js
git commit -m "feat(assistant): hydrate visible messages from persisted history"
```

---

### Task 5: Componente `MessageBubble`

**Files:**
- Create: `src/assistant/MessageBubble.jsx`

- [ ] **Step 1: Crear el archivo**

```jsx
// Renders one conversation message. Assistant bubbles show markdown text,
// tool-call chips and a collapsible reasoning block.
import React from "react";
import { renderMarkdown } from "../markdown";
import { MessageStatus, ToolStatus } from "./messages";

function ToolChip({ tool }) {
  const done = tool.status === ToolStatus.COMPLETED;
  const label = tool.label || tool.tool;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${
        done
          ? "border-green-500/40 text-green-700 dark:text-green-400"
          : "border-indigo-500/40 text-indigo-700 dark:text-indigo-300"
      }`}
      title={tool.tool}
    >
      <span aria-hidden>{tool.emoji || "\u26a1"}</span>
      <span className="truncate max-w-[180px]">{label}</span>
      {!done && <span className="w-2 h-2 rounded-full bg-indigo-500 animate-pulse" />}
    </span>
  );
}

export default function MessageBubble({ message, t }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm px-4 py-2 bg-indigo-600 text-white whitespace-pre-wrap break-words">
          {message.content}
        </div>
      </div>
    );
  }

  const isStreaming = message.status === MessageStatus.STREAMING;
  const isError = message.status === MessageStatus.ERROR;

  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] w-full rounded-2xl rounded-bl-sm px-4 py-3 glass-card border border-[var(--border-light)]">
        {message.tools?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {message.tools.map((tool) => (
              <ToolChip key={tool.toolCallId} tool={tool} />
            ))}
          </div>
        )}

        {message.reasoning && (
          <details className="mb-2 text-xs">
            <summary className="cursor-pointer text-gray-500 select-none">
              {t("assistant.reasoning")}
            </summary>
            <div className="mt-1 whitespace-pre-wrap text-gray-500 dark:text-gray-400">
              {message.reasoning}
            </div>
          </details>
        )}

        {isError ? (
          <p className="text-red-600 dark:text-red-400">
            {message.error || t("ai.errorResponse")}
          </p>
        ) : message.content ? (
          <div
            className="text-gray-800 dark:text-gray-200 note-content prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(message.content) }}
          />
        ) : (
          isStreaming && (
            <p className="animate-pulse text-gray-500 italic flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" />
              {t("ai.thinking")}
            </p>
          )
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verificar build**

Run: `npm run build 2>&1 | tail -3`
Expected: `✓ built in` sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/assistant/MessageBubble.jsx
git commit -m "feat(assistant): MessageBubble component"
```

---

### Task 6: Componente `Composer`

**Files:**
- Create: `src/assistant/Composer.jsx`

- [ ] **Step 1: Crear el archivo**

```jsx
// Chat composer: auto-growing textarea with send/stop.
// Enter sends, Shift+Enter inserts a newline.
import React, { useEffect, useRef } from "react";
import { SendIcon, StopIcon } from "./icons";

export default function Composer({ input, setInput, onSend, onStop, isStreaming, disabled, t }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  const canSend = !isStreaming && !disabled && input.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(input);
  };

  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={ref}
        rows={1}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t("assistant.placeholder")}
        className="flex-1 resize-none bg-transparent border border-[var(--border-light)] rounded-xl px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-500 dark:placeholder-gray-400"
      />
      {isStreaming ? (
        <button
          type="button"
          onClick={onStop}
          title={t("assistant.stop")}
          aria-label={t("assistant.stop")}
          className="h-10 w-10 shrink-0 rounded-full flex items-center justify-center bg-red-600 text-white hover:bg-red-700"
        >
          <StopIcon />
        </button>
      ) : (
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          title={t("assistant.send")}
          aria-label={t("assistant.send")}
          className={`h-10 w-10 shrink-0 rounded-full flex items-center justify-center text-white ${
            canSend ? "bg-indigo-600 hover:bg-indigo-700" : "bg-gray-300 dark:bg-gray-600 cursor-not-allowed"
          }`}
        >
          <SendIcon />
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verificar build**

Run: `npm run build 2>&1 | tail -3`
Expected: `✓ built in` sin errores.

- [ ] **Step 3: Commit**

```bash
git add src/assistant/Composer.jsx
git commit -m "feat(assistant): Composer component"
```

---

### Task 7: Componente `AssistantView`

**Files:**
- Create: `src/assistant/AssistantView.jsx`

- [ ] **Step 1: Crear el archivo**

```jsx
// Full-screen chat view for the assistant (#/assistant).
// Owns the conversation state via useAssistantChat.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAssistantChat } from "./useAssistantChat";
import MessageBubble from "./MessageBubble";
import Composer from "./Composer";
import { CloseIcon, Sparkles } from "./icons";

const SUGGESTION_KEYS = [
  "assistant.suggestions.notes",
  "assistant.suggestions.calendar",
  "assistant.suggestions.summary",
  "assistant.suggestions.organize",
];

export default function AssistantView({ userId, onBack, onOpenSettings, assistantAvailable, t }) {
  const onError = useMemo(() => (err) => console.error("AI Error:", err), []);
  const { messages, isStreaming, progress, send, cancel, clearAll } = useAssistantChat({
    userId,
    onError,
  });
  const [input, setInput] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const handleSend = (text) => {
    const q = String(text ?? "").trim();
    if (!q) return;
    setInput("");
    send(q);
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="min-h-screen flex flex-col text-[var(--text-light)]">
      <header className="sticky top-0 z-10 flex items-center gap-2 px-4 sm:px-6 py-3 border-b border-[var(--border-light)] bg-[var(--card-bg-light)] backdrop-blur">
        <button
          type="button"
          onClick={onBack}
          aria-label={t("common.back")}
          title={t("common.back")}
          className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
        >
          <CloseIcon />
        </button>
        <Sparkles className="text-indigo-600 dark:text-indigo-400" />
        <h1 className="font-semibold text-indigo-700 dark:text-indigo-300">{t("assistant.title")}</h1>
        {!isEmpty && (
          <button
            type="button"
            onClick={clearAll}
            title={t("assistant.clear")}
            className="ml-auto text-sm px-3 py-1 rounded-lg border border-[var(--border-light)] hover:bg-black/5 dark:hover:bg-white/10"
          >
            {t("assistant.clear")}
          </button>
        )}
      </header>

      <div ref={listRef} className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        <div className="max-w-2xl mx-auto flex flex-col gap-4">
          {!assistantAvailable ? (
            <div className="glass-card rounded-xl p-6 text-center">
              <p className="mb-3">{t("assistant.notConfigured")}</p>
              <button
                type="button"
                onClick={onOpenSettings}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700"
              >
                {t("common.settings")}
              </button>
            </div>
          ) : isEmpty ? (
            <div className="py-10 text-center">
              <h2 className="text-lg font-semibold mb-1">{t("assistant.emptyTitle")}</h2>
              <p className="text-sm text-gray-500 mb-6">{t("assistant.emptyHint")}</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {SUGGESTION_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => handleSend(t(k))}
                    className="text-sm px-3 py-1.5 rounded-full border border-[var(--border-light)] hover:bg-indigo-600/10"
                  >
                    {t(k)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <MessageBubble key={m.id} message={m} t={t} />)
          )}
        </div>
      </div>

      <div className="border-t border-[var(--border-light)] px-4 sm:px-6 py-3">
        <div className="max-w-2xl mx-auto">
          {isStreaming && (
            <div className="h-1 mb-2 rounded bg-indigo-500/20 overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all duration-300"
                style={{ width: progress ? `${progress}%` : "30%" }}
              />
            </div>
          )}
          <Composer
            input={input}
            setInput={setInput}
            onSend={handleSend}
            onStop={cancel}
            isStreaming={isStreaming}
            disabled={!assistantAvailable}
            t={t}
          />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verificar build**

Run: `npm run build 2>&1 | tail -3`
Expected: `✓ built in` sin errores (el componente aún no está cableado; no debe romper).

- [ ] **Step 3: Commit**

```bash
git add src/assistant/AssistantView.jsx
git commit -m "feat(assistant): AssistantView full-screen chat"
```

---

### Task 8: Cablear la ruta `#/assistant` y la entrada de menú

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Importar `AssistantView`**

En `src/App.jsx`, junto a los imports del asistente (línea ~7-10), añade:

```js
import AssistantView from "./assistant/AssistantView";
```

- [ ] **Step 2: Permitir la ruta en el redirect**

Reemplaza (línea 7043):

```js
    if (currentUser?.email && route !== "#/notes" && route !== "#/admin") navigate("#/notes");
```

por:

```js
    if (currentUser?.email && route !== "#/notes" && route !== "#/admin" && route !== "#/assistant") navigate("#/notes");
```

- [ ] **Step 3: Añadir la rama de render**

Justo antes del `return (` final que renderiza `<TagSidebar />...` (línea ~7128), añade:

```jsx
  if (route === "#/assistant") {
    return (
      <AssistantView
        userId={currentUser?.id}
        onBack={() => navigate("#/notes")}
        onOpenSettings={() => setSettingsPanelOpen(true)}
        assistantAvailable={assistantAvailable}
        t={t}
      />
    );
  }

```

- [ ] **Step 4: Añadir la prop `onOpenAssistant` a `NotesUI`**

En la lista de props de `<NotesUI ...>` (línea ~7256), junto a `assistantAvailable={assistantAvailable}`, añade:

```jsx
        onOpenAssistant={() => navigate("#/assistant")}
```

- [ ] **Step 5: Aceptar la prop en `NotesUI`**

En la desestructuración de props de `NotesUI` (línea 2557), añade `onOpenAssistant`:

```js
  localAiEnabled, aiResponse, setAiResponse, isAiLoading, aiLoadingProgress, onAiSearch, onClearAiHistory, assistantAvailable, onOpenAssistant, onToggleAiMode, t
```

- [ ] **Step 6: Añadir la entrada "Asistente" al menú de 3 puntos**

En el menú (dentro del bloque que abre en la línea ~2770), añade este botón **antes** del botón de Ajustes (línea ~2783):

```jsx
                {assistantAvailable && (
                  <button
                    className={`flex items-center gap-2 w-full text-left px-3 py-2 text-sm ${dark ? "hover:bg-white/10" : "hover:bg-gray-100"}`}
                    onClick={() => { setHeaderMenuOpen(false); onOpenAssistant?.(); }}
                  >
                    <Sparkles />
                    {t('menu.assistant')}
                  </button>
                )}
```

- [ ] **Step 7: Verificar build y probar en local**

Run: `npm run build 2>&1 | tail -3`
Expected: `✓ built in`.

Luego, con el stack local arriba (`http://127.0.0.1:5173`), navegar a `#/assistant` (menú → Asistente) y comprobar que se ve el estado vacío con sugerencias (aún conviven el modo IA viejo de notas; se retira en Task 9).

- [ ] **Step 8: Commit**

```bash
git add src/App.jsx
git commit -m "feat(assistant): route #/assistant + menu entry"
```

---

### Task 9: Retirar el modo IA de la pantalla de notas

**Files:**
- Modify: `src/App.jsx`

- [ ] **Step 1: Quitar el toggle ✨, el placeholder IA y el botón "preguntar" de la barra**

En `NotesUI`, elimina el bloque del toggle (líneas ~2698-2711, el `{assistantAvailable && ( <button ... <Sparkles /> ... )}`).

Cambia el `<input>` de búsqueda (líneas ~2712-2725):

```jsx
            <input
              type="text"
              name="notes-search"
              enterKeyHint="search"
              placeholder={t('notes.searchPlaceholder')}
              className="w-full bg-transparent border border-[var(--border-light)] rounded-lg pl-4 pr-10 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500 placeholder-gray-500 dark:placeholder-gray-400"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
```

Elimina el botón de "preguntar a IA" (líneas ~2727-2737, el `{localAiEnabled && search.trim().length > 0 && ( <button ... <SendIcon /> ... )}`). Deja el botón de limpiar (×) intacto.

- [ ] **Step 2: Quitar la tarjeta de respuesta inline**

Elimina el bloque (líneas ~2907-2919):

```jsx
      {/* AI Response Box */}
      <AssistantResponseCard
        visible={localAiEnabled && (aiResponse || isAiLoading)}
        text={aiResponse}
        isLoading={isAiLoading}
        progress={aiLoadingProgress}
        onClear={() => {
          setAiResponse(null);
          setSearch('');
          onClearAiHistory?.();
        }}
        t={t}
      />
```

- [ ] **Step 3: Eliminar el `SendIcon` local (ya no se usa)**

En `src/App.jsx`, elimina la definición `const SendIcon = () => ( ... );` (líneas ~250-254). Verifica que no queden usos:

Run: `grep -n "SendIcon" src/App.jsx`
Expected: sin resultados.

- [ ] **Step 4: Quitar props de IA de `NotesUI`**

En la desestructuración (línea 2557), deja sólo lo que sigue en uso:

```js
  assistantAvailable, onOpenAssistant, t
```

(elimina `localAiEnabled, aiResponse, setAiResponse, isAiLoading, aiLoadingProgress, onAiSearch, onClearAiHistory, onToggleAiMode`).

- [ ] **Step 5: Quitar el toggle "IA local" de `SettingsPanel`**

En la firma de `SettingsPanel` (línea 1777), elimina `localAiEnabled, setLocalAiEnabled,`.

Elimina el bloque del toggle (líneas ~1895-1931, desde `<div className="flex items-center justify-between">` del `settings.localAi` hasta su `</div>` de cierre, dejando la sección `UI Preferences` con sus otros hijos).

- [ ] **Step 6: Quitar el estado y efectos de IA en `App`**

En `App()` elimina:

1. El estado y derivaciones del asistente (líneas ~3511-3540):

```jsx
  // Assistant conversation: ... (todo el bloque)
  const [localAiEnabled, setLocalAiEnabled] = useState(() => { ... });
  const logAssistantError = useCallback(...);
  const assistant = useAssistantChat({ ... });
  const lastAssistant = lastAssistantMessage(assistant.messages);
  const aiResponse = lastAssistant ? ... ;
  const isAiLoading = assistant.isStreaming;
  const aiLoadingProgress = assistant.progress;
  const setAiResponse = assistant.clearResponse;
  const assistantSend = assistant.send;
  const assistantClearAll = assistant.clearAll;
```

2. El efecto de guardado (líneas ~3878-3881):

```jsx
  useEffect(() => {
    try { localStorage.setItem("localAiEnabled", String(localAiEnabled)); } catch (e) { }
    if (!localAiEnabled) setAiResponse(null);
  }, [localAiEnabled, setAiResponse]);
```

3. La función `toggleAiMode` (líneas ~3577-3586).

4. En el efecto de estado del asistente (líneas ~3552-3575), deja sólo:

```jsx
        if (cancelled) return;
        if (creds) setAssistantCreds(creds);
        const available = !!(data?.enabled && data?.configured);
        setAssistantAvailable(available);
```

(elimina el bloque `if (available) { let hidden ... } else { setLocalAiEnabled(false); }`).

5. En `saveAssistantCredentials`, elimina la línea `try { localStorage.removeItem("localAiHidden"); } catch (e) { /* ignore */ }` (línea ~3593).

6. Elimina los imports ya no usados (líneas ~7-10): `useAssistantChat`, `lastAssistantMessage, MessageStatus`, `AssistantResponseCard`. Mantén `renderMarkdown` (se usa en 367 y 6306) y `CloseIcon, Sparkles` (se usan en varios sitios, incluido el menú).

7. Elimina los props de IA pasados a `<NotesUI ...>` (líneas ~7248-7257), dejando:

```jsx
        // AI props
        assistantAvailable={assistantAvailable}
        onOpenAssistant={() => navigate("#/assistant")}
        t={t}
```

8. Elimina los props `localAiEnabled`/`setLocalAiEnabled` pasados a `<SettingsPanel ...>` (líneas ~7156-7157).

- [ ] **Step 7: Verificar que no queden referencias**

Run: `grep -nE "localAiEnabled|localAiHidden|toggleAiMode|aiResponse|isAiLoading|aiLoadingProgress|onAiSearch|onClearAiHistory|AssistantResponseCard|useAssistantChat|lastAssistantMessage" src/App.jsx`
Expected: sin resultados.

- [ ] **Step 8: Build + eslint**

Run: `npm run build 2>&1 | tail -3`
Expected: `✓ built in`.

Run: `npx eslint src server mcp 2>&1 | tail -2`
Expected: `✖ ... problems (150 errors, 10 warnings)` — sin nuevos.

- [ ] **Step 9: Commit**

```bash
git add src/App.jsx
git commit -m "refactor(assistant): remove AI mode from notes search + settings toggle"
```

---

### Task 10: Verificación final

**Files:** (sin cambios de código)

- [ ] **Step 1: Suite completa**

Run:
```bash
npm run build 2>&1 | tail -3
node test/assistant-stream.mjs
npx eslint src server mcp 2>&1 | tail -2
```
Expected: build OK; `ASSISTANT STREAM TEST: PASS`; eslint `150 errors, 10 warnings`.

- [ ] **Step 2: Regresión backend/MCP**

Run:
```bash
GLASSKEEP_TEST_URL=http://127.0.0.1:8096 node server/test/calendar-manual.mjs
node mcp/test/smoke.mjs 2>&1 | tail -3
```
(Levanta el server de prueba en 8096 si hace falta.)
Expected: Calendar `PASS` (10/10); MCP `27 ok / 1 FAIL` (el preexistente "15 herramientas").

- [ ] **Step 3: Verificación manual en el stack local (`http://127.0.0.1:5173`)**

Comprobar:
- Menú → Asistente abre `#/assistant`.
- Estado vacío con 4 chips; al hacer clic envia la pregunta.
- Streaming: aparece "pensando", luego texto; chips de herramientas se actualizan; "Razonamiento" se despliega.
- Botón Detener durante streaming.
- Recargar la página mantiene el historial (hidratación).
- "Limpiar conversación" vacía la vista y `assistantHistory-<userId>`.
- La pantalla de notas NO tiene toggle ✨ ni tarjeta IA; la búsqueda es normal.
- Ajustes NO tiene el toggle "IA local".
- Claro/oscuro y móvil (ventana estrecha).

- [ ] **Step 4: Actualizar el doc de Fases 0/1**

En `docs/assistant/2026-10-13-fases-0-1-linea-base-y-decisiones.md`, añade una nota final: "Fase 2 implementada — ver `docs/superpowers/plans/2026-10-13-assistant-chat-view.md`".

- [ ] **Step 5: Commit final**

```bash
git add docs/assistant/2026-10-13-fases-0-1-linea-base-y-decisiones.md
git commit -m "docs(assistant): note Fase 2 view implemented"
```

---

## Self-Review

- **Spec coverage:** ubicación `#/assistant` (Task 7-8), retirar modo IA de notas + toggle Ajustes + estado (Task 9), texto+tools+reasoning (Task 5), hidratación (Task 1,4), sugerencias (Task 7), composer Enviar/Detener (Task 6), i18n (Task 2), routing/menú (Task 8), verificación (Task 10). Cobertura completa.
- **Placeholders:** sin TBD/TODO; todos los pasos con código real.
- **Type consistency:** `historyToMessages`, `useAssistantChat({ userId, onError, hydrate })`, `MessageStatus`/`ToolStatus`, `message.tools[].toolCallId/label/emoji/status`, `assistant.title/placeholder/send/stop/clear/reasoning/emptyTitle/emptyHint/notConfigured/suggestions.*` y `menu.assistant` se usan de forma consistente entre tareas.
