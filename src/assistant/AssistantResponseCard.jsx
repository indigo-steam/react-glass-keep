// The assistant response card currently rendered below the header.
//
// Extracted from NotesUI verbatim so the markup/behaviour is unchanged; the
// refactor only moved the code. A future chat view will replace this card, and
// the richer message model (tool calls, reasoning, errors) is already available
// in `useAssistantChat` for when that happens.
import React from "react";
import { CloseIcon, Sparkles } from "./icons";
import { renderMarkdown } from "../markdown";

export default function AssistantResponseCard({ visible, text, isLoading, progress, onClear, t }) {
  if (!visible) return null;

  return (
    <div className="px-4 sm:px-6 md:px-8 lg:px-12 mb-6">
      <div className="max-w-2xl mx-auto glass-card rounded-xl shadow-lg p-5 border border-indigo-500/30 relative overflow-hidden bg-gradient-to-br from-indigo-50/50 to-purple-50/50 dark:from-indigo-950/30 dark:to-purple-950/30">
        {isLoading && (
          <div className="absolute top-0 left-0 h-1 bg-indigo-500 transition-all duration-300"
            style={{ width: progress ? `${progress}%` : '5%' }}
          />
        )}
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="text-indigo-600 dark:text-indigo-400" />
          <h3 className="font-semibold text-indigo-700 dark:text-indigo-300">{t('ai.assistant')}</h3>
          {text && !isLoading && (
            <button
              onClick={onClear}
              className="ml-auto p-1 rounded-full hover:bg-black/5 dark:hover:bg-white/10"
              title={t('ai.clearResponse')}
            >
              <CloseIcon />
            </button>
          )}
        </div>
        <div className="text-sm prose prose-sm dark:prose-invert max-w-none">
          {isLoading ? (
            <p className="animate-pulse text-gray-500 italic flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-500 animate-bounce" />
              {t('ai.thinking')}
            </p>
          ) : (
            <div
              className="text-gray-800 dark:text-gray-200 note-content"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
