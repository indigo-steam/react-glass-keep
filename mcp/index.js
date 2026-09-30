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
  apiKey: process.env.GLASSKEEP_API_KEY,
  agentName: process.env.GLASSKEEP_AGENT_NAME || "Asistente",
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
      queries: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("Alias de query: términos a buscar (se combinan)"),
      tags: z
        .array(z.string())
        .optional()
        .describe("Tags que la nota debe tener (case-insensitive)"),
      include_archived: z.boolean().optional().describe("Incluir notas archivadas (default false)"),
      limit: z.number().int().min(1).max(50).optional().describe("Máximo de resultados (default 20)"),
    },
  },
  async ({ query, queries, tags, include_archived, limit }) => {
    try {
      const effectiveQuery =
        query || (Array.isArray(queries) ? queries.join(" ") : queries || "");
      const notes = await client.listNotes({ includeArchived: !!include_archived });
      const filtered = notes
        .filter((n) => noteHasTags(n, tags))
        .filter((n) => noteMatchesQuery(n, effectiveQuery))
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

const itemSchema = z.object({
  text: z.string(),
  done: z.boolean().optional(),
});

server.registerTool(
  "create_note",
  {
    title: "Crear nota",
    description:
      "Crea una nota nueva para el usuario autenticado (texto o checklist). Devuelve la nota creada.",
    inputSchema: {
      title: z.string().min(1).describe("Título de la nota"),
      content: z.string().optional().describe("Contenido markdown (notas de tipo text)"),
      tags: z.array(z.string()).optional().describe("Tags de la nota"),
      type: z.enum(["text", "checklist"]).optional().describe("Tipo de nota (default text)"),
      items: z
        .array(itemSchema)
        .optional()
        .describe("Ítems de la checklist (solo para type=checklist)"),
    },
  },
  async ({ title, content, tags, type, items }) => {
    try {
      const noteType = type === "checklist" ? "checklist" : "text";
      if (noteType === "checklist" && (!items || items.length === 0)) {
        return errorResult("Una nota checklist necesita al menos un ítem en 'items'.");
      }
      const created = await client.createNote({
        type: noteType,
        title,
        content: noteType === "text" ? content || "" : "",
        tags: tags || [],
        items: items || [],
      });
      return textResult(noteFull(created));
    } catch (err) {
      return errorResult(`Error creando la nota: ${err.message}`);
    }
  }
);

server.registerTool(
  "update_note",
  {
    title: "Actualizar nota",
    description:
      "Actualiza parcialmente una nota (lee antes de escribir, nunca sobrescribe campos no enviados). " +
      "Devuelve la nota actualizada.",
    inputSchema: {
      id: z.string().describe("Id de la nota"),
      title: z.string().optional().describe("Nuevo título"),
      content: z.string().optional().describe("Nuevo contenido markdown"),
      tags: z.array(z.string()).optional().describe("Nuevos tags (reemplaza la lista)"),
      items: z.array(itemSchema).optional().describe("Nuevos ítems (checklist)"),
      pinned: z.boolean().optional().describe("Fijar/desfijar"),
      color: z.string().optional().describe("Color de la nota"),
    },
  },
  async ({ id, ...changes }) => {
    try {
      const existing = await client.getNote(id);
      if (!existing) return errorResult(`No existe una nota con id "${id}" para este usuario.`);
      const payload = {};
      for (const [key, value] of Object.entries(changes)) {
        if (value !== undefined) payload[key] = value;
      }
      if (Object.keys(payload).length === 0) {
        return errorResult("No enviaste ningún campo para actualizar.");
      }
      await client.patchNote(id, payload);
      const updated = await client.getNote(id);
      return textResult(noteFull(updated || existing));
    } catch (err) {
      return errorResult(`Error actualizando la nota: ${err.message}`);
    }
  }
);

server.registerTool(
  "archive_note",
  {
    title: "Archivar o desarchivar nota",
    description: "Archiva (archived=true, default) o desarchiva (archived=false) una nota.",
    inputSchema: {
      id: z.string().describe("Id de la nota"),
      archived: z.boolean().optional().describe("true archiva, false desarchiva (default true)"),
    },
  },
  async ({ id, archived }) => {
    try {
      const existing = await client.getNote(id);
      if (!existing) return errorResult(`No existe una nota con id "${id}" para este usuario.`);
      await client.archiveNote(id, archived !== false);
      const updated = await client.getNote(id);
      return textResult({ id, title: updated?.title || existing.title, archived: !!updated?.archived });
    } catch (err) {
      return errorResult(`Error archivando la nota: ${err.message}`);
    }
  }
);

server.registerTool(
  "restore_note",
  {
    title: "Restaurar nota de la papelera",
    description:
      "Recupera una nota que estaba en la papelera. (Para desarchivar usá archive_note con archived=false.)",
    inputSchema: {
      id: z.string().describe("Id de la nota"),
    },
  },
  async ({ id }) => {
    try {
      const existing = await client.getNote(id);
      if (!existing) return errorResult(`No existe una nota con id "${id}" para este usuario.`);
      await client.restoreNote(id);
      const updated = await client.getNote(id);
      return textResult(noteFull(updated || existing));
    } catch (err) {
      return errorResult(`Error restaurando la nota: ${err.message}`);
    }
  }
);

server.registerTool(
  "delete_note",
  {
    title: "Mover nota a la papelera",
    description:
      "Mueve una nota a la papelera (recuperable). Requiere confirm=true. Nunca borra de forma permanente.",
    inputSchema: {
      id: z.string().describe("Id de la nota"),
      confirm: z.boolean().describe("Debe ser true para confirmar la operación"),
    },
  },
  async ({ id, confirm }) => {
    if (confirm !== true) {
      return errorResult(
        "Operación cancelada: para mover la nota a la papelera enviá confirm=true (es recuperable)."
      );
    }
    try {
      const existing = await client.getNote(id);
      if (!existing) return errorResult(`No existe una nota con id "${id}" para este usuario.`);
      await client.trashNote(id);
      return textResult({
        ok: true,
        id,
        title: existing.title,
        message: "Nota movida a la papelera (recuperable desde la app).",
      });
    } catch (err) {
      return errorResult(`Error moviendo la nota a la papelera: ${err.message}`);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[indigo-notes-mcp] conectado a ${client.baseUrl} (stdio)`);
