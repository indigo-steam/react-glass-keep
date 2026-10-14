// Public entry point for the assistant client.
//
// The implementation now lives under ./assistant/* (transport in `stream.js`,
// SSE parsing in `sse.js`, model in `messages.js`, React state in
// `useAssistantChat.js`). This module keeps the historical exports working so
// nothing that still imports `askAI`/`initAI` breaks.
import { streamAssistant, STREAM_EVENT } from "./assistant/stream";

export { streamAssistant, STREAM_EVENT };

export async function initAI(onProgress) {
  // No-op: the agent runs server-side.
  if (onProgress) onProgress({ status: "ready" });
  return Promise.resolve();
}

/**
 * Backward-compatible wrapper around `streamAssistant`.
 *
 * The legacy contract emits `{ status:'init'|'delta'|'ready', text }` where
 * `text` is the *accumulated* answer (not just the latest chunk), matching the
 * pre-refactor behaviour.
 *
 * @param {string} question
 * @param {Array} _notes  (deprecated: kept for backward compatibility)
 * @param {Function} onProgress
 * @param {Array} history  previous turns [{role:'user'|'assistant', content}]
 * @returns {Promise<string>} the assistant's answer
 */
export async function askAI(question, _notes, onProgress, history = []) {
  let answer = "";
  return streamAssistant(question, {
    history,
    onEvent: (event) => {
      if (!onProgress) return;
      if (event.type === STREAM_EVENT.DELTA) {
        answer += event.text;
        onProgress({ status: "delta", text: answer });
      } else if (event.type === STREAM_EVENT.START) {
        onProgress({ status: "init" });
      } else if (event.type === STREAM_EVENT.DONE) {
        onProgress({ status: "ready" });
      }
    },
  });
}
