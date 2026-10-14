#!/usr/bin/env node
// Node-only tests for the pure assistant modules (no test runner in the repo).
//
// Covers the SSE parser + frame interpretation (the piece that must not lose
// Hermes stream events) and the typed message model.
//
// Usage:  node test/assistant-stream.mjs

import { createSseParser, interpretFrame, STREAM_EVENT } from "../src/assistant/sse.js";
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

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Feed a raw SSE string through the parser, returning every interpreted event.
function run(rawChunks) {
  const events = [];
  const parser = createSseParser((frame) => {
    for (const ev of interpretFrame(frame)) events.push(ev);
  });
  for (const chunk of rawChunks) parser.feed(chunk);
  parser.end();
  return events;
}

// ---- SSE parser + interpretation ----
console.log("SSE parser + interpretation");

{
  // A real-ish Hermes stream: reasoning, a tool running/completed, answer text,
  // finish_reason and the [DONE] terminator. Split mid-frame on purpose.
  const raw =
    'event: hermes.tool.progress\n' +
    'data: {"tool":"mcp__glasskeep__get_current_time","emoji":"⚡","label":"mcp__glasskeep__get_current_time","toolCallId":"call_1","status":"running"}\n\n' +
    'event: hermes.tool.progress\n' +
    'data: {"tool":"mcp__glasskeep__get_current_time","toolCallId":"call_1","status":"completed"}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"Let"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":" me check."}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"content":"Son las 09:0"}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"content":"0 en Bogotá."}}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: [DONE]\n\n';

  const lastPass = run([raw.slice(0, 37), raw.slice(37)]);

  check("emits two tool events (running + completed)", lastPass.filter((e) => e.type === STREAM_EVENT.TOOL).length === 2);
  const [tool1, tool2] = lastPass.filter((e) => e.type === STREAM_EVENT.TOOL);
  check("tool event carries toolCallId + status", tool1?.tool?.toolCallId === "call_1" && tool1?.tool?.status === "running");
  check("tool completion event status=completed", tool2?.tool?.status === "completed");
  check("emits reasoning deltas", lastPass.filter((e) => e.type === STREAM_EVENT.REASONING).map((e) => e.text).join("") === "Let me check.");
  check("emits content deltas", lastPass.filter((e) => e.type === STREAM_EVENT.DELTA).map((e) => e.text).join("") === "Son las 09:00 en Bogotá.");
  check("emits finish event", lastPass.some((e) => e.type === STREAM_EVENT.FINISH && e.reason === "stop"));
  check("[DONE] produces no event", !lastPass.some((e) => e.type === STREAM_EVENT.DONE));
  check("chunk splitting does not lose frames", lastPass.filter((e) => e.type === STREAM_EVENT.TOOL).length === 2);
}

{
  // Unknown named event and non-JSON data must be surfaced, not dropped.
  const unknownEvent = interpretFrame({ event: "hermes.custom.thing", data: '{"a":1}' });
  check("unknown named event -> UNKNOWN", unknownEvent.length === 1 && unknownEvent[0].type === STREAM_EVENT.UNKNOWN);

  const badJson = interpretFrame({ event: "message", data: "not json" });
  check("malformed data -> UNKNOWN", badJson.length === 1 && badJson[0].type === STREAM_EVENT.UNKNOWN);

  const emptyFrame = interpretFrame({ event: "message", data: "" });
  check("empty data -> no events", emptyFrame.length === 0);
}

// ---- Message model ----
console.log("Message model");

{
  const user = createUserMessage("hola");
  check("user message shape", user.role === "user" && user.content === "hola" && !!user.id);

  let a = createAssistantMessage();
  check("assistant starts streaming", a.role === "assistant" && a.status === MessageStatus.STREAMING && a.tools.length === 0);

  a = appendDelta(a, "Son las ");
  a = appendDelta(a, "09:00");
  check("appendDelta accumulates", a.content === "Son las 09:00");

  a = appendReasoning(a, "pensando");
  check("appendReasoning accumulates", a.reasoning === "pensando");

  const raw = { tool: "mcp__glasskeep__search_notes", label: "Fintrak", toolCallId: "call_9", status: "running" };
  a = { ...a, tools: upsertTool(a.tools, normalizeTool(raw)) };
  check("normalizeTool keeps toolCallId", a.tools[0].toolCallId === "call_9" && a.tools[0].status === "running");
  check("running tool has startedAt and no endedAt", !!a.tools[0].startedAt && a.tools[0].endedAt === null);

  a = { ...a, tools: upsertTool(a.tools, normalizeTool({ ...raw, status: "completed" })) };
  check("upsertTool dedups by toolCallId (retry-safe)", a.tools.length === 1);
  check("completed tool sets endedAt", a.tools[0].status === ToolStatus.COMPLETED && !!a.tools[0].endedAt);

  const missingId = normalizeTool({ tool: "x" });
  check("normalizeTool generates an id when absent", typeof missingId.toolCallId === "string" && missingId.toolCallId.length > 0);

  check("normalizeTool accepts snake_case alias", normalizeTool({ name: "y", tool_call_id: "z" }).toolCallId === "z");
}

{
  const msgs = [createUserMessage("a"), createAssistantMessage(), createUserMessage("b")];
  const last = lastAssistantMessage(msgs);
  check("lastAssistantMessage finds the last assistant", last?.role === "assistant" && last === msgs[1]);
  check("lastAssistantMessage on empty -> null", lastAssistantMessage([]) === null);
}

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

if (failures === 0) {
  console.log("ASSISTANT STREAM TEST: PASS");
  process.exit(0);
} else {
  console.log(`ASSISTANT STREAM TEST: FAIL (${failures})`);
  process.exit(1);
}
