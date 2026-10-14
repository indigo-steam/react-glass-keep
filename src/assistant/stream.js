// Assistant transport: talks to the Indigo Notes Assistant API, which proxies
// to the user's own Hermes agent (per-user instance) over SSE. No model runs in
// the browser and no API keys ever reach the frontend.
//
// This module owns the network + auth concerns and re-emits the upstream stream
// as typed events via `onEvent`, so callers never have to know the raw SSE
// framing. Parsing lives in `sse.js` (pure, testable).
import i18n from "../i18n";
import { createSseParser, interpretFrame, STREAM_EVENT } from "./sse";

export { STREAM_EVENT };

const API_BASE = "/api";
const AUTH_KEY = "glass-keep-auth";

const getAuthToken = () => {
  try {
    const auth = JSON.parse(localStorage.getItem(AUTH_KEY) || "null");
    return auth?.token;
  } catch {
    return null;
  }
};

/**
 * Stream an assistant answer.
 *
 * @param {string} question
 * @param {object} [options]
 * @param {Array<{role:string,content:string}>} [options.history] previous turns
 * @param {(event: object) => void} [options.onEvent] typed stream events
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<string>} the accumulated answer text
 */
export async function streamAssistant(question, { history = [], onEvent, signal } = {}) {
  const emit = (event) => {
    if (!onEvent) return;
    try {
      onEvent(event);
    } catch {
      /* a listener error must not break the stream */
    }
  };

  const token = getAuthToken();
  if (!token) {
    const err = new Error(i18n.t("errors.aiLoginRequired"));
    emit({ type: STREAM_EVENT.ERROR, error: err.message });
    throw err;
  }

  emit({ type: STREAM_EVENT.START });

  const messages = [
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: question },
  ];

  let response;
  try {
    response = await fetch(`${API_BASE}/assistant/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ messages }),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") throw err;
    const wrapped = new Error(i18n.t("errors.serverResponded", { status: "network" }));
    emit({ type: STREAM_EVENT.ERROR, error: wrapped.message });
    throw wrapped;
  }

  if (!response.ok || !response.body) {
    let detail = "";
    try {
      const data = await response.json();
      detail = data?.error || "";
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(detail || i18n.t("errors.serverResponded", { status: response.status }));
    emit({ type: STREAM_EVENT.ERROR, error: err.message });
    throw err;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let answer = "";

  const parser = createSseParser((frame) => {
    for (const event of interpretFrame(frame)) {
      if (event.type === STREAM_EVENT.DELTA) answer += event.text;
      emit(event);
    }
  });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.end();
  } catch (err) {
    if (err?.name !== "AbortError") {
      emit({ type: STREAM_EVENT.ERROR, error: err?.message || String(err) });
    }
    throw err;
  }

  const text = answer.trim();
  emit({ type: STREAM_EVENT.DONE, text });
  return text;
}
