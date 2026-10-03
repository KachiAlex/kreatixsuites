// HTML/URL hygiene for document-sourced markup. Document content (slide text,
// rich cell text, AI ops output) is attacker-influenced once a file is shared,
// so it is sanitized before every innerHTML sink.
import DOMPurify from "dompurify";

/** Sanitize document-authored HTML for rendering — strips scripts, event
 *  handlers, and active/embed contexts while keeping formatting markup. */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style", "form", "input", "iframe", "object", "embed", "link", "meta", "base"],
    FORBID_ATTR: ["srcdoc", "formaction", "xlink:href"],
  });
}

/** Only navigation-safe schemes — anything else (javascript:, data:, vbscript:,
 *  protocol-relative oddities) returns null. `u` may be a bare domain; it's
 *  resolved against the app origin first so "example.com" stays a site link. */
export function safeUrl(u: string | null | undefined): string | null {
  const raw = (u ?? "").trim();
  if (!raw) return null;
  if (raw.startsWith("#")) return raw; // in-app anchors
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
  try {
    const p = new URL(candidate);
    if (p.protocol === "http:" || p.protocol === "https:" || p.protocol === "mailto:" || p.protocol === "tel:") {
      return p.href;
    }
    return null;
  } catch {
    return null;
  }
}
