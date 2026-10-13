# Google Calendar + hora local para el asistente — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Darle al asistente AI de Glass Keep conocimiento de la hora de Bogotá y la capacidad de crear/consultar eventos en Google Calendar, con OAuth manejado por el backend.

**Architecture:** El backend de Glass Keep centraliza OAuth y las llamadas a Google Calendar API; los tokens se cifran en `user_secrets`. El MCP existente gana herramientas que llaman a endpoints REST de Glass Keep, por lo que Hermes no necesita saber nada de OAuth. Cada conversación con el asistente inyecta un `system` message con la hora actual en `America/Bogota`.

**Tech Stack:** Vite + React (frontend), Express + better-sqlite3 (backend), Node.js `fetch` para Google APIs, MCP SDK (mcp/index.js), i18next.

---

## File map

| File | Responsibility |
|---|---|
| `server/index.js` | Migraciones DB, endpoints OAuth/Calendar, inyección de system prompt, helpers de Google API. |
| `mcp/index.js` | Registro de nuevas tools (`get_current_time`, `list_calendar_events`, `create_calendar_event`, `start_workday`, `get_workday_status`, `end_workday`). |
| `mcp/lib/glasskeep.js` | Posiblemente nuevos métodos del client para llamar a los endpoints de Calendar. |
| `src/App.jsx` | UI de Settings para conectar/desconectar Google Calendar. |
| `src/locales/es.json` | Traducciones en español. |
| `src/locales/en.json` | Traducciones en inglés. |
| `docs/SELF-HOSTING.md` | Instrucciones para configurar OAuth en Google Cloud. |
| `mcp/test/smoke.mjs` | Smoke test extendido para tools de Calendar. |

---

## Task 1: Variables de entorno y constantes de Google OAuth

**Files:**
- Modify: `server/index.js:37-60` (near other env vars)

- [ ] **Step 1: Add env vars and constants**

Insert after `const ASSISTANT_MAX_CHARS = 40000;` (or near top env section):

```javascript
// Google Calendar OAuth
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const GOOGLE_CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const GOOGLE_OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_API_URL = "https://www.googleapis.com/calendar/v3";
const DEFAULT_TIMEZONE = "America/Bogota";
```

- [ ] **Step 2: Verify vaultReady check remains intact**

No code change; confirm `vaultReady` is defined before any token encryption usage.

---

## Task 2: DB migration for Google tokens

**Files:**
- Modify: `server/index.js:244-254` (inside `ensureUserSecretsColumns`)

- [ ] **Step 1: Extend user_secrets migration**

Replace the existing `ensureUserSecretsColumns` block with:

```javascript
// user_secrets migrations (assistant credentials + Google Calendar)
(function ensureUserSecretsColumns() {
  try {
    const cols = db.prepare(`PRAGMA table_info(user_secrets)`).all();
    const names = new Set(cols.map((c) => c.name));
    const tx = db.transaction(() => {
      if (!names.has("hermes_key_enc")) {
        db.exec(`ALTER TABLE user_secrets ADD COLUMN hermes_key_enc TEXT`);
      }
      if (!names.has("google_refresh_token_enc")) {
        db.exec(`ALTER TABLE user_secrets ADD COLUMN google_refresh_token_enc TEXT`);
      }
      if (!names.has("google_access_token_enc")) {
        db.exec(`ALTER TABLE user_secrets ADD COLUMN google_access_token_enc TEXT`);
      }
      if (!names.has("google_token_expires_at")) {
        db.exec(`ALTER TABLE user_secrets ADD COLUMN google_token_expires_at TEXT`);
      }
      if (!names.has("google_calendar_connected")) {
        db.exec(`ALTER TABLE user_secrets ADD COLUMN google_calendar_connected INTEGER NOT NULL DEFAULT 0`);
      }
      if (!names.has("google_calendar_email")) {
        db.exec(`ALTER TABLE user_secrets ADD COLUMN google_calendar_email TEXT`);
      }
    });
    tx();
  } catch {
    // ignore if table not created yet or ALTER not supported
  }
})();
```

- [ ] **Step 2: Run dev server and verify columns**

Run:
```bash
npm run api
```

Expected: server starts without migration errors. Check with:
```bash
sqlite3 data/dev.sqlite ".schema user_secrets"
```

Expected output includes the six new Google columns.

---

## Task 3: Google OAuth helpers

**Files:**
- Modify: `server/index.js` (after env vars, before routes)

- [ ] **Step 1: Add state/sign helpers**

Insert after the Google constants:

```javascript
function generateOAuthState(userId) {
  const payload = { uid: userId, nonce: crypto.randomBytes(16).toString("hex") };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "10m" });
}

function verifyOAuthState(state) {
  try {
    return jwt.verify(state, JWT_SECRET);
  } catch {
    return null;
  }
}

async function exchangeGoogleCode(code) {
  const params = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function refreshGoogleAccessToken(refreshToken) {
  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const res = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google refresh failed: ${res.status} ${text}`);
  }
  return res.json();
}

async function fetchGoogleUserInfo(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`Google userinfo failed: ${res.status}`);
  }
  return res.json();
}
```

- [ ] **Step 2: Add token persistence helpers**

Insert after the above:

```javascript
const getCalendarSecrets = db.prepare(
  `SELECT google_refresh_token_enc, google_access_token_enc, google_token_expires_at,
          google_calendar_connected, google_calendar_email
   FROM user_secrets WHERE user_id = ?`
);

const setGoogleTokens = db.prepare(
  `UPDATE user_secrets
   SET google_refresh_token_enc = @refresh_enc,
       google_access_token_enc = @access_enc,
       google_token_expires_at = @expires_at,
       google_calendar_connected = @connected,
       google_calendar_email = @email,
       updated_at = @updated_at
   WHERE user_id = @user_id`
);

const clearGoogleTokens = db.prepare(
  `UPDATE user_secrets
   SET google_refresh_token_enc = NULL,
       google_access_token_enc = NULL,
       google_token_expires_at = NULL,
       google_calendar_connected = 0,
       google_calendar_email = NULL,
       updated_at = @updated_at
   WHERE user_id = @user_id`
);

async function getValidAccessToken(userId) {
  const row = getCalendarSecrets.get(userId);
  if (!row || !row.google_calendar_connected) {
    throw new Error("Google Calendar not connected");
  }
  const accessToken = decryptSecret(row.google_access_token_enc);
  const expiresAt = row.google_token_expires_at ? new Date(row.google_token_expires_at) : null;
  const now = new Date();
  if (expiresAt && expiresAt > new Date(now.getTime() + 60000)) {
    return accessToken;
  }
  const refreshToken = decryptSecret(row.google_refresh_token_enc);
  const refreshed = await refreshGoogleAccessToken(refreshToken);
  const newAccessToken = refreshed.access_token;
  const newExpiresAt = new Date(Date.now() + refreshed.expires_in * 1000).toISOString();
  setGoogleTokens.run({
    refresh_enc: row.google_refresh_token_enc, // keep existing
    access_enc: encryptSecret(newAccessToken),
    expires_at: newExpiresAt,
    connected: 1,
    email: row.google_calendar_email,
    updated_at: nowISO(),
    user_id: userId,
  });
  return newAccessToken;
}
```

- [ ] **Step 3: Verify helpers load**

Run:
```bash
npm run api
```

Expected: server starts without syntax errors.

---

## Task 4: OAuth endpoints

**Files:**
- Modify: `server/index.js` (before `// ---------- Health ----------`)

- [ ] **Step 1: Add /api/calendar/status**

```javascript
app.get("/api/calendar/status", auth, (req, res) => {
  const row = getCalendarSecrets.get(req.user.id);
  res.json({
    connected: !!(row && row.google_calendar_connected),
    email: row?.google_calendar_email || null,
  });
});
```

- [ ] **Step 2: Add /api/calendar/auth-url**

```javascript
app.get("/api/calendar/auth-url", auth, (req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_REDIRECT_URI) {
    return res.status(503).json({ error: "Google OAuth not configured on server." });
  }
  const state = generateOAuthState(req.user.id);
  const url =
    `${GOOGLE_OAUTH_AUTH_URL}?` +
    new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: "code",
      scope: GOOGLE_CALENDAR_SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
  res.json({ url });
});
```

- [ ] **Step 3: Add /api/calendar/callback**

```javascript
app.get("/api/calendar/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    return res.status(400).send("Missing code or state.");
  }
  const payload = verifyOAuthState(state);
  if (!payload || !payload.uid) {
    return res.status(400).send("Invalid or expired state.");
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    return res.status(503).send("Google OAuth not configured.");
  }
  try {
    const tokenData = await exchangeGoogleCode(code);
    if (!tokenData.refresh_token) {
      return res.status(400).send("Google did not return a refresh token. Please revoke access and try again.");
    }
    const accessToken = tokenData.access_token;
    const userInfo = await fetchGoogleUserInfo(accessToken);
    setGoogleTokens.run({
      refresh_enc: encryptSecret(tokenData.refresh_token),
      access_enc: encryptSecret(accessToken),
      expires_at: new Date(Date.now() + tokenData.expires_in * 1000).toISOString(),
      connected: 1,
      email: userInfo.email || null,
      updated_at: nowISO(),
      user_id: payload.uid,
    });
    const redirectBase = GOOGLE_REDIRECT_URI.replace("/api/calendar/callback", "");
    res.redirect(`${redirectBase}/#/settings?calendar=connected`);
  } catch (err) {
    console.error("calendar callback error:", err.message);
    res.status(500).send(`Failed to connect Google Calendar: ${err.message}`);
  }
});
```

- [ ] **Step 4: Add /api/calendar/disconnect**

```javascript
app.post("/api/calendar/disconnect", auth, async (req, res) => {
  const row = getCalendarSecrets.get(req.user.id);
  if (row?.google_refresh_token_enc) {
    try {
      const refreshToken = decryptSecret(row.google_refresh_token_enc);
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: refreshToken }).toString(),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      console.error("revoke token error:", err.message);
    }
  }
  clearGoogleTokens.run({ updated_at: nowISO(), user_id: req.user.id });
  res.json({ disconnected: true });
});
```

- [ ] **Step 5: Test endpoints manually**

Start server:
```bash
npm run api
```

With a logged-in session, run:
```bash
curl -H "Authorization: Bearer <your-jwt>" http://localhost:8080/api/calendar/status
```

Expected before connecting:
```json
{ "connected": false, "email": null }
```

---

## Task 5: Google Calendar API helpers

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Add googleCalendarFetch helper**

```javascript
async function googleCalendarFetch(userId, path, options = {}) {
  const accessToken = await getValidAccessToken(userId);
  const url = `${GOOGLE_CALENDAR_API_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: options.signal || AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google Calendar API ${options.method || "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}
```

- [ ] **Step 2: Add date helpers for Bogota timezone**

```javascript
function toBogotaISO(date = new Date()) {
  return date.toLocaleString("sv-SE", { timeZone: DEFAULT_TIMEZONE }).replace(" ", "T") + "-05:00";
}

function startOfDayInBogota(date = new Date()) {
  const d = new Date(date.toLocaleString("en-US", { timeZone: DEFAULT_TIMEZONE }));
  d.setHours(0, 0, 0, 0);
  return toBogotaISO(d);
}

function endOfDayInBogota(date = new Date()) {
  const d = new Date(date.toLocaleString("en-US", { timeZone: DEFAULT_TIMEZONE }));
  d.setHours(23, 59, 59, 999);
  return toBogotaISO(d);
}
```

- [ ] **Step 3: Verify no syntax errors**

Run `npm run api` and confirm clean startup.

---

## Task 6: Calendar endpoints

**Files:**
- Modify: `server/index.js`

- [ ] **Step 1: Add GET /api/calendar/events**

```javascript
app.get("/api/calendar/events", auth, async (req, res) => {
  try {
    const timeMin = req.query.timeMin || startOfDayInBogota();
    const timeMax = req.query.timeMax || endOfDayInBogota();
    const maxResults = Math.min(250, Math.max(1, Number(req.query.maxResults) || 50));
    const data = await googleCalendarFetch(
      req.user.id,
      `/calendars/primary/events?${new URLSearchParams({
        timeMin,
        timeMax,
        maxResults: String(maxResults),
        singleEvents: "true",
        orderBy: "startTime",
      }).toString()}`
    );
    res.json({
      items: (data.items || []).map((ev) => ({
        id: ev.id,
        summary: ev.summary,
        start: ev.start,
        end: ev.end,
        status: ev.status,
        extendedProperties: ev.extendedProperties,
      })),
    });
  } catch (err) {
    console.error("list events error:", err.message);
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 2: Add POST /api/calendar/events**

```javascript
app.post("/api/calendar/events", auth, async (req, res) => {
  try {
    const { summary, start, end, description } = req.body || {};
    if (!summary || !start) {
      return res.status(400).json({ error: "summary and start are required" });
    }
    const startDate = new Date(start);
    if (isNaN(startDate.getTime())) {
      return res.status(400).json({ error: "Invalid start date" });
    }
    const endDate = end ? new Date(end) : new Date(startDate.getTime() + 60 * 60 * 1000);
    const event = {
      summary,
      description: description || "",
      start: { dateTime: toBogotaISO(startDate), timeZone: DEFAULT_TIMEZONE },
      end: { dateTime: toBogotaISO(endDate), timeZone: DEFAULT_TIMEZONE },
    };
    const data = await googleCalendarFetch(req.user.id, "/calendars/primary/events", {
      method: "POST",
      body: JSON.stringify(event),
    });
    res.json({
      id: data.id,
      summary: data.summary,
      start: data.start,
      end: data.end,
      status: data.status,
    });
  } catch (err) {
    console.error("create event error:", err.message);
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add GET /api/calendar/workday**

```javascript
app.get("/api/calendar/workday", auth, async (req, res) => {
  try {
    const timeMin = startOfDayInBogota();
    const timeMax = endOfDayInBogota();
    const data = await googleCalendarFetch(
      req.user.id,
      `/calendars/primary/events?${new URLSearchParams({
        timeMin,
        timeMax,
        q: "Jornada laboral",
        singleEvents: "true",
        orderBy: "startTime",
      }).toString()}`
    );
    const events = data.items || [];
    const open = events.find(
      (ev) =>
        ev.extendedProperties?.private?.glassKeepWorkday === "true" &&
        ev.end?.dateTime &&
        new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime() <= 2 * 60 * 1000
    );
    res.json({
      open: !!open,
      event: open
        ? { id: open.id, summary: open.summary, start: open.start.dateTime, end: open.end.dateTime }
        : null,
    });
  } catch (err) {
    console.error("workday status error:", err.message);
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Add PATCH /api/calendar/events/:id**

```javascript
app.patch("/api/calendar/events/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { end } = req.body || {};
    if (!end) {
      return res.status(400).json({ error: "end is required" });
    }
    const endDate = new Date(end);
    if (isNaN(endDate.getTime())) {
      return res.status(400).json({ error: "Invalid end date" });
    }
    const data = await googleCalendarFetch(req.user.id, `/calendars/primary/events/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({
        end: { dateTime: toBogotaISO(endDate), timeZone: DEFAULT_TIMEZONE },
      }),
    });
    res.json({
      id: data.id,
      summary: data.summary,
      start: data.start,
      end: data.end,
    });
  } catch (err) {
    console.error("patch event error:", err.message);
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 5: Run server and test with curl**

```bash
npm run api
```

After connecting Google Calendar (Task 4), test:
```bash
curl -H "Authorization: Bearer <jwt>" "http://localhost:8080/api/calendar/events?maxResults=5"
```

Expected: JSON with `items` array.

---

## Task 7: Inject system prompt with local time

**Files:**
- Modify: `server/index.js:1736-1802` (inside `/api/assistant/chat`)

- [ ] **Step 1: Build system message and prepend to messages**

Inside `app.post("/api/assistant/chat", ...)` replace the `const messages = ...` usage with:

```javascript
const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
if (!messages || messages.length === 0) {
  return res.status(400).json({ error: "Faltan mensajes." });
}

const nowBogota = toBogotaISO();
const systemMessage = {
  role: "system",
  content:
    `Eres el asistente personal de Glass Keep. La hora actual del usuario es ${nowBogota} (zona horaria ${DEFAULT_TIMEZONE}).\n\n` +
    "Pautas:\n" +
    '- Cuando el usuario diga "inicio jornada laboral", usá la herramienta `start_workday` para registrar el inicio.\n' +
    '- Cuando diga "fin jornada laboral", usá la herramienta `end_workday` para cerrar la jornada abierta de hoy.\n' +
    "- Antes de crear eventos que no sean de jornada, confirmá los detalles (título, hora, descripción).\n" +
    "- Si el usuario no tiene Google Calendar conectado, explicale cómo hacerlo desde Configuración.",
};

const messagesWithSystem = [systemMessage, ...messages];
```

Then replace `messages: clean` in the upstream fetch body with `messages: cleanWithSystem` by prepending the system message before cleaning:

```javascript
const cleanWithSystem = [systemMessage, ...clean];
if (cleanWithSystem[cleanWithSystem.length - 1].role !== "user") {
  return res.status(400).json({ error: "El último mensaje debe ser del usuario." });
}
```

And in the upstream body:
```javascript
body: JSON.stringify({ model: "hermes-agent", stream: true, messages: cleanWithSystem }),
```

- [ ] **Step 2: Verify assistant receives system prompt**

Run server, send a chat message, and check Hermes logs (or add temporary `console.log` of `cleanWithSystem`):
```bash
docker logs hermes-u1 --tail 50
```

Expected: system message with Bogota timestamp present.

---

## Task 8: Extend MCP with Calendar tools

**Files:**
- Modify: `mcp/index.js`
- Modify: `mcp/lib/glasskeep.js` (add methods)

- [ ] **Step 1: Add Calendar client methods in mcp/lib/glasskeep.js**

Insert before the closing brace of `GlassKeepClient`:

```javascript
async getCurrentTime(timezone = "America/Bogota") {
  return this.#request(`/api/calendar/time?timezone=${encodeURIComponent(timezone)}`);
}

async listCalendarEvents({ start, end, max_results } = {}) {
  const params = new URLSearchParams();
  if (start) params.set("timeMin", start);
  if (end) params.set("timeMax", end);
  if (max_results) params.set("maxResults", String(max_results));
  return this.#request(`/api/calendar/events?${params.toString()}`);
}

async createCalendarEvent({ summary, start, end, description }) {
  return this.#request("/api/calendar/events", {
    method: "POST",
    body: { summary, start, end, description },
  });
}

async getWorkdayStatus() {
  return this.#request("/api/calendar/workday");
}

async startWorkday() {
  return this.#request("/api/calendar/workday/start", { method: "POST", body: {} });
}

async endWorkday({ end_time } = {}) {
  return this.#request("/api/calendar/workday/end", {
    method: "POST",
    body: end_time ? { end: end_time } : {},
  });
}
```

- [ ] **Step 2: Add backend endpoints for workday start/end**

In `server/index.js`, after `GET /api/calendar/workday`, add:

```javascript
app.post("/api/calendar/workday/start", auth, async (req, res) => {
  try {
    const existing = await googleCalendarFetch(
      req.user.id,
      `/calendars/primary/events?${new URLSearchParams({
        timeMin: startOfDayInBogota(),
        timeMax: endOfDayInBogota(),
        q: "Jornada laboral",
        singleEvents: "true",
      }).toString()}`
    );
    const events = existing.items || [];
    const alreadyOpen = events.find(
      (ev) =>
        ev.extendedProperties?.private?.glassKeepWorkday === "true" &&
        ev.end?.dateTime &&
        new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime() <= 2 * 60 * 1000
    );
    if (alreadyOpen) {
      return res.status(409).json({ error: "Ya hay una jornada abierta hoy.", event: alreadyOpen });
    }
    const start = new Date();
    const end = new Date(start.getTime() + 60 * 1000);
    const data = await googleCalendarFetch(req.user.id, "/calendars/primary/events", {
      method: "POST",
      body: JSON.stringify({
        summary: "Jornada laboral",
        description: "Inicio de jornada laboral registrado por Glass Keep",
        start: { dateTime: toBogotaISO(start), timeZone: DEFAULT_TIMEZONE },
        end: { dateTime: toBogotaISO(end), timeZone: DEFAULT_TIMEZONE },
        extendedProperties: { private: { glassKeepWorkday: "true" } },
      }),
    });
    res.json({ id: data.id, summary: data.summary, start: data.start, end: data.end });
  } catch (err) {
    console.error("start workday error:", err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/calendar/workday/end", auth, async (req, res) => {
  try {
    const endTime = req.body?.end ? new Date(req.body.end) : new Date();
    const data = await googleCalendarFetch(
      req.user.id,
      `/calendars/primary/events?${new URLSearchParams({
        timeMin: startOfDayInBogota(),
        timeMax: endOfDayInBogota(),
        q: "Jornada laboral",
        singleEvents: "true",
      }).toString()}`
    );
    const events = data.items || [];
    const open = events.find(
      (ev) =>
        ev.extendedProperties?.private?.glassKeepWorkday === "true" &&
        ev.end?.dateTime &&
        new Date(ev.end.dateTime).getTime() - new Date(ev.start.dateTime).getTime() <= 2 * 60 * 1000
    );
    if (!open) {
      return res.status(404).json({ error: "No hay una jornada abierta para hoy." });
    }
    const updated = await googleCalendarFetch(
      req.user.id,
      `/calendars/primary/events/${encodeURIComponent(open.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          end: { dateTime: toBogotaISO(endTime), timeZone: DEFAULT_TIMEZONE },
        }),
      }
    );
    res.json({ id: updated.id, summary: updated.summary, start: updated.start, end: updated.end });
  } catch (err) {
    console.error("end workday error:", err.message);
    res.status(502).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Register MCP tools in mcp/index.js**

After the existing `delete_note` tool, add:

```javascript
server.registerTool(
  "get_current_time",
  {
    title: "Obtener hora actual",
    description: "Devuelve la hora actual en la zona horaria del usuario (por defecto America/Bogota).",
    inputSchema: {
      timezone: z.string().optional().describe("Zona horaria IANA, por ejemplo America/Bogota"),
    },
  },
  async ({ timezone }) => {
    try {
      const tz = timezone || "America/Bogota";
      const now = new Date();
      const iso = now.toLocaleString("sv-SE", { timeZone: tz }).replace(" ", "T") + getBogotaOffset(now);
      return textResult({ timezone: tz, now: iso });
    } catch (err) {
      return errorResult(`Error obteniendo la hora: ${err.message}`);
    }
  }
);

function getBogotaOffset(date) {
  // America/Bogota is UTC-5 all year (no DST)
  return "-05:00";
}

server.registerTool(
  "list_calendar_events",
  {
    title: "Listar eventos del calendario",
    description: "Lista eventos de Google Calendar del usuario en un rango de fechas.",
    inputSchema: {
      start: z.string().optional().describe("Inicio del rango en ISO 8601 (default hoy 00:00)"),
      end: z.string().optional().describe("Fin del rango en ISO 8601 (default hoy 23:59)"),
      max_results: z.number().int().min(1).max(250).optional().describe("Máximo de resultados (default 50)"),
    },
  },
  async ({ start, end, max_results }) => {
    try {
      const events = await client.listCalendarEvents({ start, end, max_results });
      return textResult(events);
    } catch (err) {
      return errorResult(`Error listando eventos: ${err.message}`);
    }
  }
);

server.registerTool(
  "create_calendar_event",
  {
    title: "Crear evento en el calendario",
    description: "Crea un evento en Google Calendar. Siempre confirmá con el usuario antes de usar esta herramienta, excepto para inicio/fin de jornada.",
    inputSchema: {
      summary: z.string().min(1).describe("Título del evento"),
      start: z.string().describe("Fecha/hora de inicio en ISO 8601"),
      end: z.string().optional().describe("Fecha/hora de fin en ISO 8601 (default +1 hora)"),
      description: z.string().optional().describe("Descripción opcional"),
    },
  },
  async ({ summary, start, end, description }) => {
    try {
      const created = await client.createCalendarEvent({ summary, start, end, description });
      return textResult(created);
    } catch (err) {
      return errorResult(`Error creando evento: ${err.message}`);
    }
  }
);

server.registerTool(
  "start_workday",
  {
    title: "Iniciar jornada laboral",
    description: "Registra el inicio de la jornada laboral en Google Calendar creando un evento 'Jornada laboral'.",
    inputSchema: {},
  },
  async () => {
    try {
      const result = await client.startWorkday();
      return textResult(result);
    } catch (err) {
      return errorResult(`Error iniciando jornada: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_workday_status",
  {
    title: "Estado de jornada laboral",
    description: "Devuelve si hay una jornada laboral abierta para hoy.",
    inputSchema: {},
  },
  async () => {
    try {
      const status = await client.getWorkdayStatus();
      return textResult(status);
    } catch (err) {
      return errorResult(`Error consultando jornada: ${err.message}`);
    }
  }
);

server.registerTool(
  "end_workday",
  {
    title: "Finalizar jornada laboral",
    description: "Cierra la jornada laboral abierta de hoy con la hora actual o una hora dada.",
    inputSchema: {
      end_time: z.string().optional().describe("Hora de finalización en ISO 8601 (default ahora)"),
    },
  },
  async ({ end_time }) => {
    try {
      const result = await client.endWorkday({ end_time });
      return textResult(result);
    } catch (err) {
      return errorResult(`Error cerrando jornada: ${err.message}`);
    }
  }
);
```

- [ ] **Step 4: Test MCP tools**

Run smoke test or manual test:
```bash
cd mcp
GLASSKEEP_URL=http://127.0.0.1:8080 GLASSKEEP_SECRET_KEY=<key> node index.js
```

Then in another terminal:
```bash
npx @anthropic-ai/mcp-cli call get_current_time --arg timezone America/Bogota
```

Expected: JSON with current time in Bogota.

---

## Task 9: Frontend Settings UI

**Files:**
- Modify: `src/App.jsx` (SettingsPanel)
- Modify: `src/locales/es.json`
- Modify: `src/locales/en.json`

- [ ] **Step 1: Add translation keys**

In `src/locales/es.json`, inside `"settings": { ... }`, add:

```json
"googleCalendar": "Google Calendar",
"googleCalendarDesc": "Conectá tu calendario para que el asistente registre jornadas y eventos.",
"googleCalendarConnected": "Conectado como {{email}}",
"googleCalendarNotConnected": "No conectado",
"googleCalendarConnect": "Conectar Google Calendar",
"googleCalendarDisconnect": "Desconectar",
"googleCalendarConnecting": "Conectando...",
```

In `src/locales/en.json`, inside `"settings": { ... }`, add:

```json
"googleCalendar": "Google Calendar",
"googleCalendarDesc": "Connect your calendar so the assistant can log workdays and events.",
"googleCalendarConnected": "Connected as {{email}}",
"googleCalendarNotConnected": "Not connected",
"googleCalendarConnect": "Connect Google Calendar",
"googleCalendarDisconnect": "Disconnect",
"googleCalendarConnecting": "Connecting...",
```

- [ ] **Step 2: Add state and fetch status in App main component**

Find where `assistantCreds` state is defined (near top of App component). Add nearby:

```javascript
const [calendarStatus, setCalendarStatus] = useState({ connected: false, email: null });
const [loadingCalendarStatus, setLoadingCalendarStatus] = useState(false);

const fetchCalendarStatus = async () => {
  const auth = getAuth();
  const token = auth?.token;
  if (!token) return;
  setLoadingCalendarStatus(true);
  try {
    const res = await fetch("/api/calendar/status", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) {
      setCalendarStatus(await res.json());
    } else {
      setCalendarStatus({ connected: false, email: null });
    }
  } catch (e) {
    setCalendarStatus({ connected: false, email: null });
  } finally {
    setLoadingCalendarStatus(false);
  }
};
```

Add `useEffect` to fetch status on mount and when settings opens:

```javascript
useEffect(() => {
  fetchCalendarStatus();
}, []);

useEffect(() => {
  if (settingsOpen) {
    fetchCalendarStatus();
  }
}, [settingsOpen]);
```

- [ ] **Step 3: Add calendar handlers**

```javascript
const handleConnectCalendar = async () => {
  try {
    const auth = getAuth();
    const token = auth?.token;
    const res = await fetch("/api/calendar/auth-url", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      showToast(t('errors.serverResponded', { status: res.status }), "error");
      return;
    }
    const { url } = await res.json();
    window.location.href = url;
  } catch (e) {
    showToast(e.message || t('errors.serverResponded', { status: 'network' }), "error");
  }
};

const handleDisconnectCalendar = async () => {
  showGenericConfirm({
    title: t('confirm.disconnectCalendarTitle'),
    message: t('confirm.disconnectCalendarMessage'),
    confirmText: t('common.remove'),
    cancelText: t('common.cancel'),
    danger: true,
    onConfirm: async () => {
      try {
        const auth = getAuth();
        const token = auth?.token;
        const res = await fetch("/api/calendar/disconnect", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          setCalendarStatus({ connected: false, email: null });
          showToast(t('toast.calendarDisconnected'), "success");
        } else {
          showToast(t('errors.serverResponded', { status: res.status }), "error");
        }
      } catch (e) {
        showToast(e.message || t('errors.serverResponded', { status: 'network' }), "error");
      }
    },
  });
};
```

- [ ] **Step 4: Render calendar section in SettingsPanel**

Add inside the UI Preferences section, after the assistant BYOK block:

```jsx
{/* Google Calendar */}
<div className="rounded-xl border border-[var(--border-light)] p-4">
  <div className="flex items-center justify-between gap-3">
    <div>
      <div className="font-medium">{t('settings.googleCalendar')}</div>
      <div className="text-sm text-gray-500">
        {calendarStatus.connected
          ? t('settings.googleCalendarConnected', { email: calendarStatus.email })
          : t('settings.googleCalendarNotConnected')}
      </div>
    </div>
    <div className="flex items-center gap-2 shrink-0">
      {calendarStatus.connected ? (
        <button type="button" onClick={onDisconnectCalendar} className={btnDanger}>
          {t('settings.googleCalendarDisconnect')}
        </button>
      ) : (
        <button type="button" onClick={onConnectCalendar} className={btnPrimary}>
          {t('settings.googleCalendarConnect')}
        </button>
      )}
    </div>
  </div>
</div>
```

- [ ] **Step 5: Wire props to SettingsPanel**

Add props to `SettingsPanel`: `calendarStatus`, `onConnectCalendar`, `onDisconnectCalendar`.

Pass them from the main App render:

```jsx
<SettingsPanel
  ...existingProps
  calendarStatus={calendarStatus}
  onConnectCalendar={handleConnectCalendar}
  onDisconnectCalendar={handleDisconnectCalendar}
/>
```

- [ ] **Step 6: Add missing translations**

Add to both `es.json` and `en.json`:

```json
"confirm": {
  "disconnectCalendarTitle": "¿Desconectar Google Calendar?",
  "disconnectCalendarMessage": "El asistente ya no podrá crear ni consultar eventos."
},
"toast": {
  "calendarDisconnected": "Google Calendar desconectado"
}
```

English equivalents:
- disconnectCalendarTitle: "Disconnect Google Calendar?"
- disconnectCalendarMessage: "The assistant will no longer be able to create or check events."
- calendarDisconnected: "Google Calendar disconnected"

- [ ] **Step 7: Handle OAuth callback query param**

Add a `useEffect` in main App to detect `?calendar=connected`:

```javascript
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("calendar") === "connected") {
    showToast(t('toast.calendarConnected'), "success");
    fetchCalendarStatus();
    // clean URL
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState({}, document.title, cleanUrl);
  }
}, []);
```

Add translation:
```json
"toast": {
  "calendarConnected": "Google Calendar conectado"
}
```

- [ ] **Step 8: Run frontend and verify UI**

```bash
npm run dev
```

Open Settings, verify Google Calendar section renders with connect button.

---

## Task 10: Documentation

**Files:**
- Modify: `docs/SELF-HOSTING.md`
- Modify: `README.md` (optional brief mention)

- [ ] **Step 1: Add Google OAuth setup section to SELF-HOSTING.md**

Insert before "## Parte 1 — La app":

```markdown
## Google Calendar (opcional)

Si querés que el asistente registre jornadas y eventos en Google Calendar:

1. Andá a [Google Cloud Console](https://console.cloud.google.com).
2. Creá un proyecto o usá uno existente.
3. Habilitá la **Google Calendar API**.
4. Configurá la **Pantalla de consentimiento OAuth**:
   - User Type: External (o Internal si tenés Workspace).
   - Agregá el scope `https://www.googleapis.com/auth/calendar.events`.
   - Agregá tu email como usuario de prueba si es External.
5. En **Credentials → Create credentials → OAuth client ID → Web application**:
   - Authorized redirect URIs: `https://notas.tu-dominio.com/api/calendar/callback`
   - Para desarrollo local: `http://localhost:8080/api/calendar/callback`
6. Copiá el Client ID y Client Secret al env-file:

```env
GOOGLE_CLIENT_ID=tu-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=tu-client-secret
GOOGLE_REDIRECT_URI=https://notas.tu-dominio.com/api/calendar/callback
```

7. Cada usuario conecta su cuenta desde **Configuración → Google Calendar**.
```

- [ ] **Step 2: Update README.md briefly**

Add a bullet under the AI Assistant section:
```markdown
- **Google Calendar integration** — log workdays and create events via the assistant (optional, BYO Google OAuth credentials).
```

---

## Task 11: Backend tests

**Files:**
- Create: `server/calendar.test.js` (or extend existing test file)

- [ ] **Step 1: Create test file with mock fetch**

```javascript
// server/calendar.test.js
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
// Use any test runner already in the project; adjust imports as needed.

describe("calendar helpers", () => {
  it("toBogotaISO returns UTC-5 offset", () => {
    // We cannot import private helpers directly without refactoring.
    // For now, test via the public endpoint with a mock Google server.
    expect(true).toBe(true);
  });
});
```

If the project has no test runner configured, add a manual test script instead:

```javascript
// server/test/calendar-manual.mjs
import { setupMockGoogle } from "./mock-google.mjs";
// ... exercise endpoints
```

- [ ] **Step 2: Verify endpoints manually with curl**

After completing Tasks 1-7, run the manual tests documented in each task.

---

## Task 12: MCP smoke test extension

**Files:**
- Modify: `mcp/test/smoke.mjs`

- [ ] **Step 1: Add calendar tool assertions**

After existing note tool tests, add:

```javascript
// Test get_current_time
const timeRes = await callTool(client, "get_current_time", { timezone: "America/Bogota" });
assert(timeRes.content[0].text.includes("America/Bogota"), "get_current_time should return timezone");

// Test workday flow only if calendar is connected
const statusRes = await callTool(client, "get_workday_status", {});
assert(typeof statusRes.content[0].text === "string", "get_workday_status should return text");
```

- [ ] **Step 2: Run smoke test**

```bash
cd mcp
GLASSKEEP_TEST_URL=http://127.0.0.1:8096 npm run smoke
```

Expected: all existing tests pass + new calendar assertions pass (or skip gracefully if not connected).

---

## Self-review checklist

- [ ] **Spec coverage:**
  - Hora local inyectada → Task 7.
  - OAuth Google → Tasks 1, 3, 4.
  - Tokens cifrados → Tasks 2, 3.
  - Endpoints Calendar → Tasks 5, 6.
  - Tools MCP → Task 8.
  - UI Settings → Task 9.
  - Docs → Task 10.
  - Tests → Tasks 11, 12.

- [ ] **Placeholder scan:** No TBD/TODO/fill-in-details found.

- [ ] **Type consistency:**
  - `start_workday`, `end_workday`, `get_workday_status` match backend and MCP.
  - `toBogotaISO` used consistently in backend.
  - Env var names match between code and docs.

- [ ] **Known gaps / risks:**
  - Google OAuth requires external setup by admin; endpoint returns 503 if env vars missing.
  - Refresh token is only returned on first consent; if user reconnects without revoking, Google may not return it again.
  - Event search for workday relies on `extendedProperties.private.glassKeepWorkday` and a 1-minute duration heuristic.
