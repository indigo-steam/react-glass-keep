#!/usr/bin/env node
// Indigo Notes MCP server (read-only).
// Speaks MCP over stdio; talks to the Glass Keep REST API with the user's credential.
// Never touches SQLite and never uses an admin token.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  GlassKeepClient,
  noteHasTags,
  noteMatchesQuery,
  normalizeTag,
  stripDataUrls,
  toSummary,
} from "./lib/glasskeep.js";

const MAX_CONTENT_CHARS = 6000;
const MAX_RELATED_CONTENT_CHARS = 1500;

const client = new GlassKeepClient({
  baseUrl: process.env.GLASSKEEP_URL,
  secretKey: process.env.GLASSKEEP_SECRET_KEY,
  token: process.env.GLASSKEEP_TOKEN,
});

function textResult(obj) {
  return {
    content: [
      {
        type: "text",
        text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2),
      },
    ],
  };
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function noteFull(note) {
  let content = stripDataUrls(note.content || "");
  const truncated = content.length > MAX_CONTENT_CHARS;
  if (truncated) content = content.slice(0, MAX_CONTENT_CHARS);
  return {
    id: note.id,
    title: note.title || "(sin título)",
    type: note.type,
    tags: note.tags || [],
    archived: !!note.archived,
    pinned: !!note.pinned,
    content,
    content_truncated: truncated || undefined,
    items: (note.items || []).map((it) => ({ text: it.text, done: !!it.done })),
    created_at: note.created_at || note.timestamp,
    updated_at: note.updated_at,
    last_edited_by: note.lastEditedBy || undefined,
    image_count: (note.images || []).length,
  };
}

function formatNoteForLLM(note, maxChars = MAX_RELATED_CONTENT_CHARS) {
  let content = stripDataUrls(note.content || "");
  if (content.length > maxChars) content = `${content.slice(0, maxChars)}…[truncado]`;
  const items = (note.items || []).map((it) => `  - [${it.done ? "x" : " "}] ${it.text}`).join("\n");
  return [
    `## ${note.title || "(sin título)"}`,
    `- id: ${note.id}`,
    `- tipo: ${note.type}${note.archived ? " (archivada)" : ""}`,
    `- tags: ${(note.tags || []).join(", ") || "—"}`,
    `- fechas: creada ${note.created_at || note.timestamp || "?"} · actualizada ${note.updated_at || "?"}`,
    "",
    content || "(sin contenido)",
    items ? `\nÍtems:\n${items}` : "",
  ].join("\n");
}

const server = new McpServer({ name: "indigo-notes", version: "0.1.0" });

server.registerTool(
  "search_notes",
  {
    title: "Buscar notas",
    description:
      "Busca notas del usuario autenticado por texto (título, contenido, ítems y tags) y/o tags. " +
      "Devuelve resúmenes con id, título, tags, fechas y un extracto.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Términos a buscar; todos deben aparecer (case-insensitive)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags que la nota debe tener (case-insensitive)"),
      include_archived: z.boolean().optional().describe("Incluir notas archivadas (default false)"),
      limit: z.number().int().min(1).max(50).optional().describe("Máximo de resultados (default 20)"),
    },
  },
  async ({ query, tags, include_archived, limit }) => {
    try {
      const notes = await client.listNotes({ includeArchived: !!include_archived });
      const filtered = notes
        .filter((n) => noteHasTags(n, tags))
        .filter((n) => noteMatchesQuery(n, query))
        .sort((a, b) =>
          String(b.updated_at || b.timestamp || "").localeCompare(
            String(a.updated_at || a.timestamp || "")
          )
        )
        .slice(0, limit ?? 20);
      return textResult({ count: filtered.length, notes: filtered.map(toSummary) });
    } catch (err) {
      return errorResult(`Error buscando notas: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_note",
  {
    title: "Obtener nota",
    description: "Devuelve una nota completa por id (incluye archivadas).",
    inputSchema: {
      id: z.string().describe("Id de la nota"),
    },
  },
  async ({ id }) => {
    try {
      const note = await client.getNote(id);
      if (!note) return errorResult(`No existe una nota con id "${id}" para este usuario.`);
      return textResult(noteFull(note));
    } catch (err) {
      return errorResult(`Error obteniendo la nota: ${err.message}`);
    }
  }
);

server.registerTool(
  "list_tags",
  {
    title: "Listar tags",
    description:
      "Lista los tags de las notas del usuario (activas y archivadas) con su conteo, " +
      "agrupados sin distinguir mayúsculas/minúsculas.",
    inputSchema: {},
  },
  async () => {
    try {
      const notes = await client.listNotes({ includeArchived: true });
      const byKey = new Map();
      for (const note of notes) {
        for (const raw of note.tags || []) {
          const key = normalizeTag(raw);
          if (!key) continue;
          const display = String(raw).trim();
          const entry = byKey.get(key) || { tag: display, count: 0, variants: new Set() };
          entry.count += 1;
          entry.variants.add(display);
          byKey.set(key, entry);
        }
      }
      const tags = [...byKey.values()]
        .map((e) => ({ tag: e.tag, count: e.count, variants: [...e.variants] }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
      return textResult({ count: tags.length, tags });
    } catch (err) {
      return errorResult(`Error listando tags: ${err.message}`);
    }
  }
);

server.registerTool(
  "get_context",
  {
    title: "Contexto para el asistente",
    description:
      "Devuelve una nota focal (opcional, por id) más notas relacionadas (por tags compartidos " +
      "o por búsqueda) para dar contexto al asistente antes de responder.",
    inputSchema: {
      note_id: z.string().optional().describe("Id de la nota focal, si la hay"),
      query: z.string().optional().describe("Términos para buscar notas relacionadas"),
      max_notes: z.number().int().min(1).max(25).optional().describe("Máximo de notas (default 10)"),
    },
  },
  async ({ note_id, query, max_notes }) => {
    try {
      const cap = max_notes ?? 10;
      const all = await client.listNotes({ includeArchived: true });
      const focal = note_id ? all.find((n) => String(n.id) === String(note_id)) || null : null;
      if (note_id && !focal) {
        return errorResult(`No existe una nota con id "${note_id}" para este usuario.`);
      }
      const focalTags = new Set((focal?.tags || []).map(normalizeTag));
      const effectiveQuery =
        query || (focal ? [focal.title, ...(focal.tags || [])].filter(Boolean).join(" ") : "");
      const seen = new Set(focal ? [String(focal.id)] : []);
      const related = [];
      const maxRelated = cap - (focal ? 1 : 0);
      for (const note of all) {
        if (seen.has(String(note.id))) continue;
        const sharesTag = focal && (note.tags || []).some((t) => focalTags.has(normalizeTag(t)));
        if (sharesTag || (effectiveQuery && noteMatchesQuery(note, effectiveQuery))) {
          related.push(note);
          seen.add(String(note.id));
          if (related.length >= maxRelated) break;
        }
      }
      const blocks = [];
      if (focal) blocks.push(`# NOTA FOCAL\n${formatNoteForLLM(focal, MAX_CONTENT_CHARS)}`);
      if (related.length) {
        blocks.push(
          `# NOTAS RELACIONADAS (${related.length})\n` +
            related.map((n) => formatNoteForLLM(n)).join("\n\n---\n\n")
        );
      }
      if (!blocks.length) return textResult("Sin resultados para el contexto solicitado.");
      return textResult(blocks.join("\n\n"));
    } catch (err) {
      return errorResult(`Error armando el contexto: ${err.message}`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[indigo-notes-mcp] conectado a ${client.baseUrl} (stdio)`);
