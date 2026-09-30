// Minimal REST client for Indigo Notes (Glass Keep) used by the MCP server.
// Read-only by design: only GETs plus POST /api/login/secret for auth.

const DEFAULT_TIMEOUT_MS = 20000;

export function stripDataUrls(text) {
  if (typeof text !== "string") return "";
  return text.replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, "[imagen-embebida]");
}

export function normalizeTag(tag) {
  return String(tag || "").trim().toLowerCase();
}

export function notePlainText(note) {
  const parts = [
    note.title || "",
    stripDataUrls(note.content || ""),
    ...(note.items || []).map((it) => it.text || ""),
  ];
  return parts.filter(Boolean).join("\n");
}

export function noteMatchesQuery(note, query) {
  if (!query) return true;
  const haystack = [notePlainText(note), ...(note.tags || [])].join("\n").toLowerCase();
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function noteHasTags(note, tags) {
  if (!tags || tags.length === 0) return true;
  const own = new Set((note.tags || []).map(normalizeTag));
  return tags.map(normalizeTag).every((t) => own.has(t));
}

export function noteSnippet(note, max = 220) {
  const text = notePlainText(note).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function toSummary(note) {
  return {
    id: note.id,
    title: note.title || "(sin título)",
    type: note.type,
    tags: note.tags || [],
    archived: !!note.archived,
    pinned: !!note.pinned,
    updated_at: note.updated_at || note.timestamp || note.created_at,
    snippet: noteSnippet(note),
  };
}

export class GlassKeepClient {
  constructor({ baseUrl, secretKey, token } = {}) {
    this.baseUrl = String(baseUrl || "http://127.0.0.1:8080").replace(/\/+$/, "");
    this.secretKey = secretKey || "";
    this.token = token || "";
  }

  async login() {
    if (!this.secretKey) {
      throw new Error(
        "Falta la credencial del MCP: define GLASSKEEP_SECRET_KEY (recomendado) o GLASSKEEP_TOKEN."
      );
    }
    const data = await this.#request(
      "/api/login/secret",
      { method: "POST", body: { key: this.secretKey }, auth: false }
    );
    this.token = data.token;
    return this.token;
  }

  async #request(pathname, { method = "GET", body, auth = true } = {}, retried = false) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth) {
      if (!this.token) await this.login();
      headers.Authorization = `Bearer ${this.token}`;
    }
    let res;
    try {
      res = await fetch(this.baseUrl + pathname, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`No se pudo conectar a ${this.baseUrl}${pathname}: ${err.message}`);
    }
    if (res.status === 401 && auth && !retried && this.secretKey) {
      this.token = "";
      return this.#request(pathname, { method, body, auth }, true);
    }
    if (!res.ok) {
      throw new Error(`GlassKeep API ${method} ${pathname} → HTTP ${res.status}`);
    }
    return res.json();
  }

  async listNotes({ includeArchived = false } = {}) {
    const active = await this.#request("/api/notes");
    if (!includeArchived) return active;
    const archived = await this.#request("/api/notes/archived");
    return active.concat(archived);
  }

  async getNote(id) {
    const notes = await this.listNotes({ includeArchived: true });
    return notes.find((n) => String(n.id) === String(id)) || null;
  }
}
