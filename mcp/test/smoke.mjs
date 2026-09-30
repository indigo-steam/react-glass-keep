#!/usr/bin/env node
// Self-contained smoke test for the Indigo Notes MCP (read-only).
//
// Requires a running Glass Keep instance where registration works (dev) or where
// the two test accounts already exist:
//   GLASSKEEP_TEST_URL            (default http://127.0.0.1:8096)
//   GLASSKEEP_TEST_EMAIL_A        (default alice@test.com)
//   GLASSKEEP_TEST_PASSWORD_A     (default alicepass123)
//   GLASSKEEP_TEST_EMAIL_B        (default bob@test.com)
//   GLASSKEEP_TEST_PASSWORD_B     (default bobpass123)
//
// It seeds two users' notes, spawns the MCP over stdio for each user and
// verifies tool behavior plus per-user isolation. Cleans up after itself.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const URL_BASE = process.env.GLASSKEEP_TEST_URL || "http://127.0.0.1:8096";
const EMAIL_A = process.env.GLASSKEEP_TEST_EMAIL_A || "alice@test.com";
const PASS_A = process.env.GLASSKEEP_TEST_PASSWORD_A || "alicepass123";
const EMAIL_B = process.env.GLASSKEEP_TEST_EMAIL_B || "bob@test.com";
const PASS_B = process.env.GLASSKEEP_TEST_PASSWORD_B || "bobpass123";

const mcpDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runId = `smoke-${Date.now()}`;

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

async function ensureUser(email, password) {
  await api("/api/register", { method: "POST", body: { name: email.split("@")[0], email, password } });
  const login = await api("/api/login", { method: "POST", body: { email, password } });
  if (login.status !== 200) {
    throw new Error(`No se pudo autenticar ${email} (HTTP ${login.status}). ¿El server de test está corriendo con registro habilitado?`);
  }
  const { key } = (await api("/api/secret-key", { method: "POST", token: login.data.token })).data;
  if (!key) throw new Error(`No se pudo crear secret key para ${email}`);
  return { token: login.data.token, secretKey: key };
}

async function connectMcp(secretKey) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["index.js"],
    cwd: mcpDir,
    env: { ...getDefaultEnvironment(), GLASSKEEP_URL: URL_BASE, GLASSKEEP_SECRET_KEY: secretKey },
  });
  const client = new Client({ name: "mcp-smoke", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

function toolJson(result) {
  const text = result.content?.find((c) => c.type === "text")?.text || "";
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

async function call(client, name, args = {}) {
  return client.callTool({ name, arguments: args });
}

const created = []; // { token, id }

async function main() {
  console.log(`URL: ${URL_BASE} | run: ${runId}`);

  const alice = await ensureUser(EMAIL_A, PASS_A);
  const bob = await ensureUser(EMAIL_B, PASS_B);

  const mk = async (token, note) => {
    const r = await api("/api/notes", { method: "POST", token, body: note });
    created.push({ token, id: r.data.id });
    return r.data.id;
  };

  const aliceNoteId = await mk(alice.token, {
    type: "text",
    title: `${runId} Moto aceite`,
    content: `Cambio de aceite de la moto. Proyecto Fintrak y SENA pendientes. ${runId}`,
    tags: ["Moto", "Fintrak"],
  });
  const bobNoteId = await mk(bob.token, {
    type: "text",
    title: `${runId} privado de bob`,
    content: `Secreto de bob ${runId}`,
    tags: ["PrivadoBob"],
  });

  const mcpA = await connectMcp(alice.secretKey);
  const tools = (await mcpA.listTools()).tools.map((t) => t.name).sort();
  check("expone las 4 herramientas", JSON.stringify(tools) === JSON.stringify(["get_context", "get_note", "list_tags", "search_notes"]), tools.join(","));

  const search = toolJson(await call(mcpA, "search_notes", { query: runId }));
  check("search_notes encuentra la nota de alice", search.notes?.some((n) => n.id === aliceNoteId), JSON.stringify(search).slice(0, 200));
  check("search_notes NO ve la nota de bob", !JSON.stringify(search).includes(bobNoteId));

  const byTag = toolJson(await call(mcpA, "search_notes", { query: "aceite", tags: ["moto", "fintrak"] }));
  check("search_notes filtra por tags case-insensitive", byTag.notes?.some((n) => n.id === aliceNoteId));

  const noQuery = toolJson(await call(mcpA, "search_notes", {}));
  check("search_notes sin query devuelve solo notas del usuario", noQuery.notes?.every((n) => n.id !== bobNoteId));

  const full = toolJson(await call(mcpA, "get_note", { id: aliceNoteId }));
  check("get_note devuelve el contenido completo", full.content?.includes(runId) && full.title?.includes("Moto"));

  const missing = await call(mcpA, "get_note", { id: "no-existe-123" });
  check("get_note de id inexistente devuelve error controlado", missing.isError === true);

  const tags = toolJson(await call(mcpA, "list_tags", {}));
  const motoTag = tags.tags?.find((t) => t.tag.toLowerCase() === "moto");
  check("list_tags agrupa tags case-insensitive", !!motoTag && motoTag.count >= 1, JSON.stringify(tags).slice(0, 200));

  const context = await call(mcpA, "get_context", { note_id: aliceNoteId, max_notes: 5 });
  const contextText = context.content?.find((c) => c.type === "text")?.text || "";
  check("get_context incluye la nota focal", contextText.includes(runId) && contextText.includes("# NOTA FOCAL"));

  // Isolation: bob's MCP must not see alice's notes.
  const mcpB = await connectMcp(bob.secretKey);
  const bobSearch = toolJson(await call(mcpB, "search_notes", { query: runId }));
  check("bob ve su propia nota", bobSearch.notes?.some((n) => n.id === bobNoteId));
  check("bob NO ve la nota de alice", !JSON.stringify(bobSearch).includes(aliceNoteId));
  const aliceAsBob = await call(mcpB, "get_note", { id: aliceNoteId });
  check("bob no puede leer la nota de alice por id", aliceAsBob.isError === true);

  await mcpA.close();
  await mcpB.close();
}

async function cleanup() {
  for (const { token, id } of created) {
    if (!id) continue;
    await api(`/api/notes/${id}?permanent=1`, { method: "DELETE", token }).catch(() => {});
  }
}

try {
  await main();
} catch (err) {
  failures += 1;
  console.error(`ERROR: ${err.message}`);
} finally {
  await cleanup();
}

if (failures === 0) {
  console.log("MCP SMOKE: PASS");
  process.exit(0);
} else {
  console.log(`MCP SMOKE: FAIL (${failures})`);
  process.exit(1);
}
