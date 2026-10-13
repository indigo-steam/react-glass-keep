#!/usr/bin/env node
// Manual backend test for Google Calendar helper endpoints.
// Runs against a live Glass Keep API server. Does NOT require Google OAuth.
//
// Usage:
//   node server/test/calendar-manual.mjs
//   GLASSKEEP_TEST_URL=http://127.0.0.1:8096 node server/test/calendar-manual.mjs
//
// The script creates a throwaway user, fetches a JWT, then exercises the public
// calendar endpoints. It expects the server to have registration enabled.

const URL_BASE = process.env.GLASSKEEP_TEST_URL || "http://127.0.0.1:8096";
const EMAIL = process.env.GLASSKEEP_TEST_EMAIL || "alice@test.com";
const PASSWORD = process.env.GLASSKEEP_TEST_PASSWORD || "alicepass123";

let failures = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function api(pathname, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(URL_BASE + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function getToken() {
  // Try to login first; if the account does not exist and registration is open,
  // create it. This mirrors the MCP smoke test behavior.
  const login = await api("/api/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  if (login.status === 200) return login.data.token;

  const register = await api("/api/register", {
    method: "POST",
    body: { name: EMAIL.split("@")[0], email: EMAIL, password: PASSWORD },
  });
  if (register.status !== 200 && register.status !== 201) {
    throw new Error(`Failed to login or register test user (HTTP ${register.status}): ${JSON.stringify(register.data)}`);
  }
  const retry = await api("/api/login", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  if (retry.status !== 200) {
    throw new Error(`Failed to login after register (HTTP ${retry.status}): ${JSON.stringify(retry.data)}`);
  }
  return retry.data.token;
}

async function main() {
  console.log(`URL: ${URL_BASE} | user: ${EMAIL}`);

  const token = await getToken();

  // Endpoint: status (no Google connection configured)
  const status = await api("/api/calendar/status", { token });
  check(
    "/api/calendar/status returns connected=false",
    status.status === 200 && status.data.connected === false,
    JSON.stringify(status.data)
  );
  check(
    "/api/calendar/status returns email=null",
    status.status === 200 && status.data.email === null,
    JSON.stringify(status.data)
  );

  // Endpoint: auth-url (should be 503 when Google OAuth env is missing)
  const authUrl = await api("/api/calendar/auth-url", { token });
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REDIRECT_URI) {
    check(
      "/api/calendar/auth-url returns a Google URL when configured",
      authUrl.status === 200 && typeof authUrl.data.url === "string" && authUrl.data.url.includes("accounts.google.com"),
      JSON.stringify(authUrl.data)
    );
  } else {
    check(
      "/api/calendar/auth-url returns 503 when OAuth not configured",
      authUrl.status === 503 && authUrl.data.error,
      `HTTP ${authUrl.status} ${JSON.stringify(authUrl.data)}`
    );
  }

  // Endpoint: current time
  const time = await api("/api/calendar/time", { token });
  check(
    "/api/calendar/time returns default America/Bogota timezone",
    time.status === 200 && time.data.timezone === "America/Bogota" && typeof time.data.now === "string",
    JSON.stringify(time.data)
  );

  const timeTz = await api("/api/calendar/time?timezone=UTC", { token });
  check(
    "/api/calendar/time respects timezone query param",
    timeTz.status === 200 && timeTz.data.timezone === "UTC" && typeof timeTz.data.now === "string",
    JSON.stringify(timeTz.data)
  );

  // Endpoints that require a connected Google Calendar should fail gracefully
  const events = await api("/api/calendar/events", { token });
  check(
    "/api/calendar/events returns error when not connected",
    events.status === 502 && events.data.error && events.data.error.includes("Google Calendar not connected"),
    `HTTP ${events.status} ${JSON.stringify(events.data)}`
  );

  const workday = await api("/api/calendar/workday", { token });
  check(
    "/api/calendar/workday returns error when not connected",
    workday.status === 502 && workday.data.error && workday.data.error.includes("Google Calendar not connected"),
    `HTTP ${workday.status} ${JSON.stringify(workday.data)}`
  );

  const startWorkday = await api("/api/calendar/workday/start", { method: "POST", token, body: {} });
  check(
    "/api/calendar/workday/start returns error when not connected",
    startWorkday.status === 502 && startWorkday.data.error && startWorkday.data.error.includes("Google Calendar not connected"),
    `HTTP ${startWorkday.status} ${JSON.stringify(startWorkday.data)}`
  );

  const endWorkday = await api("/api/calendar/workday/end", { method: "POST", token, body: {} });
  check(
    "/api/calendar/workday/end returns error when not connected",
    endWorkday.status === 502 && endWorkday.data.error && endWorkday.data.error.includes("Google Calendar not connected"),
    `HTTP ${endWorkday.status} ${JSON.stringify(endWorkday.data)}`
  );

  const createEvent = await api("/api/calendar/events", {
    method: "POST",
    token,
    body: { summary: "Test event", start: new Date().toISOString() },
  });
  check(
    "/api/calendar/events POST returns error when not connected",
    createEvent.status === 502 && createEvent.data.error && createEvent.data.error.includes("Google Calendar not connected"),
    `HTTP ${createEvent.status} ${JSON.stringify(createEvent.data)}`
  );
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.error(`ERROR: ${err.message}`);
}

if (failures === 0) {
  console.log("CALENDAR MANUAL TEST: PASS");
  process.exit(0);
} else {
  console.log(`CALENDAR MANUAL TEST: FAIL (${failures})`);
  process.exit(1);
}
