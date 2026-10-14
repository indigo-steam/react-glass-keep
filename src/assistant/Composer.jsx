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
