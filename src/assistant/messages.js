// Typed message model for the assistant conversation.
//
// Pure and dependency-free so it can be reused by any UI (the current single
// response card now, a full chat view later) and exercised directly in Node.
//
// Shapes (documented, not enforced at runtime):
//   UserMessage      { id, role:'user', content, createdAt }
//   AssistantMessage { id, role:'assistant', content, reasoning,
//                      status:'streaming'|'done'|'error',
//                      tools: ToolCall[], error: string|null, createdAt }
//   ToolCall         { toolCallId, tool, label, emoji, status,
//                      startedAt, endedAt }

export const MessageStatus = Object.freeze({
  STREAMING: "streaming",
  DONE: "done",
  ERROR: "error",
});

export const ToolStatus = Object.freeze({
  RUNNING: "running",
  COMPLETED: "completed",
  ERROR: "error",
});

let counter = 0;

export function newMessageId(prefix = "m") {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

export function createUserMessage(content) {
  return {
    id: newMessageId("u"),
    role: "user",
    content: String(content ?? ""),
    createdAt: Date.now(),
  };
}

export function createAssistantMessage() {
  return {
    id: newMessageId("a"),
    role: "assistant",
    content: "",
    reasoning: "",
    status: MessageStatus.STREAMING,
    tools: [],
    error: null,
    createdAt: Date.now(),
  };
}

export function appendDelta(message, text) {
  return { ...message, content: (message.content || "") + text };
}

export function appendReasoning(message, text) {
  return { ...message, reasoning: (message.reasoning || "") + text };
}

/**
 * Normalise a raw Hermes tool payload into a stable ToolCall shape.
 * Tolerant to snake_case aliases so contract drift doesn't lose data.
 */
export function normalizeTool(tool) {
  const t = tool && typeof tool === "object" ? tool : {};
  const name = t.tool || t.name || "tool";
  return {
    toolCallId: t.toolCallId || t.tool_call_id || newMessageId("tool"),
    tool: name,
    label: t.label || name,
    emoji: t.emoji || "\u26a1",
    status: t.status || ToolStatus.RUNNING,
  };
}

/**
 * Insert or update a tool call inside an assistant message's `tools` array,
 * keyed by toolCallId (this is what makes retries deterministic: a repeated
 * `running`/`completed` pair updates the same entry instead of duplicating it).
 */
export function upsertTool(tools, toolEvent) {
  const list = Array.isArray(tools) ? tools.slice() : [];
  const idx = list.findIndex((t) => t.toolCallId === toolEvent.toolCallId);
  const now = Date.now();
  if (idx === -1) {
    list.push({
      ...toolEvent,
      startedAt: now,
      endedAt: toolEvent.status === ToolStatus.COMPLETED ? now : null,
    });
  } else {
    const prev = list[idx];
    list[idx] = {
      ...prev,
      ...toolEvent,
      startedAt: prev.startedAt ?? now,
      endedAt:
        toolEvent.status === ToolStatus.COMPLETED
          ? now
          : prev.endedAt ?? null,
    };
  }
  return list;
}

export function lastAssistantMessage(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === "assistant") return list[i];
  }
  return null;
}

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
