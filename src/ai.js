import i18n from './i18n';

/**
 * AI Assistant client.
 * Talks to the Indigo Notes Assistant API, which proxies to the user's own
 * Hermes agent (per-user instance) over SSE. No model runs in the browser and
 * no API keys ever reach the frontend.
 */

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

export async function initAI(onProgress) {
  // No-op: the agent runs server-side.
  if (onProgress) onProgress({ status: 'ready' });
  return Promise.resolve();
}

/**
 * Ask the assistant a question. The agent searches the user's notes by itself
 * (GlassKeep MCP), so we only send the question.
 * @param {string} question
 * @param {Array} _notes  (deprecated: kept for backward compatibility)
 * @param {Function} onProgress  receives {status:'init'|'delta'|'ready', text?}
 * @returns {Promise<string>} the assistant's answer
 */
export async function askAI(question, _notes, onProgress) {
  const token = getAuthToken();
  if (!token) {
    throw new Error(i18n.t('errors.aiLoginRequired'));
  }

  if (onProgress) onProgress({ status: 'init' });

  let response;
  try {
    response = await fetch(`${API_BASE}/assistant/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ messages: [{ role: 'user', content: question }] })
    });
  } catch {
    throw new Error(i18n.t('errors.serverResponded', { status: 'network' }));
  }

  if (!response.ok || !response.body) {
    let detail = '';
    try {
      const data = await response.json();
      detail = data?.error || '';
    } catch { /* non-JSON error */ }
    throw new Error(detail || i18n.t('errors.serverResponded', { status: response.status }));
  }

  // Parse the OpenAI-style SSE stream, accumulating the answer text.
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) {
          answer += delta;
          if (onProgress) onProgress({ status: 'delta', text: answer });
        }
      } catch {
        /* ignore malformed keepalive lines */
      }
    }
  }

  if (onProgress) onProgress({ status: 'ready' });
  return answer.trim();
}
