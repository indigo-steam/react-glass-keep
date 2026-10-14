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
