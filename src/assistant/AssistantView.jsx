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
