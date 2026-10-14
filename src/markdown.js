// Shared Markdown renderer. Extracted from App.jsx so the assistant components
// (and anything else) can reuse the exact same sanitized rendering.
import { marked as markedParser } from "marked";
import DOMPurify from "dompurify";

// Ensure we can call marked.parse(...)
const marked =
  typeof markedParser === "function" ? { parse: markedParser } : markedParser;

// Sanitize rendered markdown before injecting it as HTML (prevents stored XSS)
export const renderMarkdown = (md) =>
  DOMPurify.sanitize(marked.parse(md || ""), {
    USE_PROFILES: { html: true },
    ADD_DATA_URI_TAGS: ["img"],
  });
