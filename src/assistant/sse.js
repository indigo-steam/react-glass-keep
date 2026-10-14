// Server-Sent Events (SSE) framing + interpretation for the assistant stream.
//
// Pure module on purpose: no React, no i18n and no browser APIs, so it can be
// exercised directly with Node. `stream.js` layers transport (fetch + auth) on
// top of it.
//
// The assistant upstream (Hermes) speaks OpenAI-style SSE chunks
// (`data: {"choices":[{"delta":{...}}]}`) plus named events for tool progress
// (`event: hermes.tool.progress` + `data: {"tool":...,"status":"running"}`) and
// reasoning deltas (`delta.reasoning_content`). All of them are surfaced here.

export const STREAM_EVENT = Object.freeze({
  START: "start",
  DELTA: "delta",
  REASONING: "reasoning",
  TOOL: "tool",
  FINISH: "finish",
  DONE: "done",
  ERROR: "error",
  UNKNOWN: "unknown",
});

/**
 * Incremental SSE parser.
 * Feed it decoded text chunks; it invokes `onFrame({ event, data })` for each
 * complete SSE frame (i.e. when a blank line is reached). Lines are handled per
 * the SSE spec (field `:`, optional single leading space in the value, `event:`
 * and `data:` fields) and CRLF is tolerated.
 *
 * @param {(frame: { event: string, data: string }) => void} onFrame
 * @returns {{ feed: (chunk: string) => void, end: () => void }}
 */
export function createSseParser(onFrame) {
  let buffer = "";
  let eventName = "";
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length === 0 && eventName === "") return;
    const frame = { event: eventName || "message", data: dataLines.join("\n") };
    eventName = "";
    dataLines = [];
    onFrame(frame);
  };

  const feed = (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        dispatch();
        continue;
      }
      if (line.startsWith(":")) continue; // comment / keepalive
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") eventName = value;
      else if (field === "data") dataLines.push(value);
      // `id` and `retry` are not used by this stream.
    }
  };

  const end = () => dispatch();

  return { feed, end };
}

/**
 * Interpret a parsed SSE frame into zero or more assistant stream events.
 * Returns `[]` for terminators (`[DONE]`). Unknown frames are surfaced as
 * `UNKNOWN` so information is never silently discarded.
 *
 * @param {{ event: string, data: string }} frame
 * @returns {Array<object>}
 */
export function interpretFrame(frame) {
  const event = frame?.event || "message";
  const data = frame?.data ?? "";

  if (data === "" || data === "[DONE]") return []; // stream terminator

  let json;
  try {
    json = JSON.parse(data);
  } catch {
    return [{ type: STREAM_EVENT.UNKNOWN, event, data }];
  }

  // Named custom event (e.g. "hermes.tool.progress") carrying tool status.
  if (event !== "message") {
    if (json && typeof json === "object" && json.tool) {
      return [{ type: STREAM_EVENT.TOOL, tool: json }];
    }
    return [{ type: STREAM_EVENT.UNKNOWN, event, data: json }];
  }

  const choice = Array.isArray(json?.choices) ? json.choices[0] : null;
  const delta = choice?.delta;
  const out = [];
  if (delta?.reasoning_content) {
    out.push({ type: STREAM_EVENT.REASONING, text: String(delta.reasoning_content) });
  }
  if (typeof delta?.content === "string" && delta.content.length > 0) {
    out.push({ type: STREAM_EVENT.DELTA, text: delta.content });
  }
  if (choice?.finish_reason) {
    out.push({ type: STREAM_EVENT.FINISH, reason: String(choice.finish_reason) });
  }
  if (out.length === 0) {
    out.push({ type: STREAM_EVENT.UNKNOWN, event, data: json });
  }
  return out;
}
