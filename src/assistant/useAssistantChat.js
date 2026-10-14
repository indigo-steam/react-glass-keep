// React hook that owns the assistant conversation state.
//
// Responsibilities:
//  - keep the typed message list for the current session (user / assistant,
//    with tool calls, reasoning, error and loading status);
//  - drive the streaming transport (`stream.js`) and fold its typed events
//    into that model;
//  - persist the *text-only* context under the same localStorage key/shape as
//    before the refactor (`assistantHistory-<userId>`, capped at 20 turns) so
//    reload behaviour and the backend contract stay unchanged.
//
// It intentionally does NOT render anything — the current single response card
// and a future chat view can both consume the same state.
import { useCallback, useEffect, useRef, useState } from "react";
import { streamAssistant } from "./stream";
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

const HISTORY_LIMIT = 20;

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

export function useAssistantChat({ userId, onError, hydrate = true } = {}) {
  const storageKey = userId ? `assistantHistory-${userId}` : null;

  const [messages, setMessages] = useState(() =>
    hydrate ? historyToMessages(loadStoredHistory(storageKey)) : []
  );
  const [isStreaming, setIsStreaming] = useState(false);
  const [progress, setProgress] = useState(null);

  // Persisted context (text-only turns). Kept in a ref so `send` is stable and
  // never reads a stale closure.
  const historyRef = useRef([]);
  const abortRef = useRef(null);
  const seededKeyRef = useRef(storageKey);

  useEffect(() => {
    const stored = loadStoredHistory(storageKey);
    historyRef.current = stored;
    if (storageKey !== seededKeyRef.current) {
      seededKeyRef.current = storageKey;
      if (hydrate) setMessages(historyToMessages(stored));
    }
  }, [storageKey, hydrate]);

  const persistHistory = useCallback(
    (history) => {
      if (!storageKey) return;
      try {
        localStorage.setItem(storageKey, JSON.stringify(history));
      } catch {
        /* storage may be full or unavailable */
      }
    },
    [storageKey]
  );

  const updateAssistant = useCallback((id, updater) => {
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? updater(m) : m))
    );
  }, []);

  const send = useCallback(
    async (question) => {
      const q = String(question ?? "").trim();
      if (!q) return;

      const userMessage = createUserMessage(q);
      const assistantMessage = createAssistantMessage();
      const assistantId = assistantMessage.id;
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      setIsStreaming(true);
      setProgress(0);

      const controller = new AbortController();
      abortRef.current = controller;
      const context = (Array.isArray(historyRef.current) ? historyRef.current : []).slice(-HISTORY_LIMIT);

      let finalText = "";
      try {
        finalText = await streamAssistant(q, {
          history: context,
          signal: controller.signal,
          onEvent: (event) => {
            switch (event.type) {
              case "delta":
                updateAssistant(assistantId, (m) => appendDelta(m, event.text));
                break;
              case "reasoning":
                updateAssistant(assistantId, (m) => appendReasoning(m, event.text));
                break;
              case "tool": {
                const toolEvent = normalizeTool(event.tool);
                updateAssistant(assistantId, (m) => ({
                  ...m,
                  tools: upsertTool(m.tools, toolEvent),
                }));
                break;
              }
              case "done":
                setProgress(100);
                break;
              default:
                break;
            }
          },
        });

        updateAssistant(assistantId, (m) => ({
          ...m,
          content: finalText,
          status: MessageStatus.DONE,
        }));

        const nextHistory = [
          ...context,
          { role: "user", content: q },
          { role: "assistant", content: finalText },
        ].slice(-HISTORY_LIMIT);
        historyRef.current = nextHistory;
        persistHistory(nextHistory);
      } catch (err) {
        if (err?.name === "AbortError") {
          // Cancelled: keep whatever was streamed so far.
          updateAssistant(assistantId, (m) => ({ ...m, status: MessageStatus.DONE }));
        } else {
          updateAssistant(assistantId, (m) => ({
            ...m,
            status: MessageStatus.ERROR,
            error: err?.message || String(err),
          }));
          onError?.(err);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setIsStreaming(false);
        setProgress(null);
      }
    },
    [persistHistory, updateAssistant, onError]
  );

  // Clear only the visible response, keeping the persisted context.
  const clearResponse = useCallback(() => setMessages([]), []);

  // Clear the response AND the persisted context ("Clear history" button).
  const clearAll = useCallback(() => {
    setMessages([]);
    historyRef.current = [];
    persistHistory([]);
  }, [persistHistory]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // Abort any in-flight stream when the consumer unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  return { messages, isStreaming, progress, send, clearResponse, clearAll, cancel };
}
