// Search indexer — extracts plain text from each doc kind's canonical JSON and
// keeps the FTS5 `search_index` table in sync. PDF body text isn't extracted
// server-side (pdf.js lives in the client); PDFs index annotation text + form
// values. Name search is handled separately in routes/search.ts.
import { db } from "./db.js";
import { getBlob } from "./blobs.js";

const stripTags = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

export function extractText(kind: string, content: unknown): string {
  const c = content as Record<string, unknown> | null;
  const out: string[] = [];

  if (kind === "writer" && c?.doc) {
    const walk = (n: { text?: unknown; content?: unknown[] }) => {
      if (typeof n?.text === "string") out.push(n.text);
      (n?.content as { text?: unknown; content?: unknown[] }[] | undefined)?.forEach(walk);
    };
    walk(c.doc as never);
  } else if (kind === "sheets" && c?.workbook) {
    for (const s of (c.workbook as { sheets?: never[] }).sheets ?? []) {
      const sh = s as { name?: string; cells?: Record<string, { v?: unknown; f?: string }>; charts?: { title?: string; labels?: unknown[] }[] };
      out.push(sh.name ?? "");
      for (const cell of Object.values(sh.cells ?? {})) {
        if (cell.v !== null && cell.v !== undefined) out.push(String(cell.v));
        if (cell.f) out.push(cell.f);
      }
      for (const ch of sh.charts ?? []) {
        if (ch.title) out.push(ch.title);
        (ch.labels ?? []).forEach((l) => out.push(String(l)));
      }
    }
  } else if (kind === "present" && c?.deck) {
    for (const sl of (c.deck as { slides?: never[] }).slides ?? []) {
      const s = sl as { notes?: string; objects?: { html?: string; table?: string[][]; chart?: { title?: string; labels?: unknown[] } }[] };
      if (s.notes) out.push(s.notes);
      for (const o of s.objects ?? []) {
        if (o.html) out.push(stripTags(o.html));
        if (o.table) for (const row of o.table) out.push(...row.map(String));
        if (o.chart) {
          if (o.chart.title) out.push(o.chart.title);
          (o.chart.labels ?? []).forEach((l) => out.push(String(l)));
        }
      }
    }
  } else if (kind === "pdf" && c?.kind === "pdf") {
    for (const a of (c.annotations as { text?: string }[] | undefined) ?? []) {
      if (a.text) out.push(a.text);
    }
    for (const v of Object.values((c.form as Record<string, unknown> | undefined) ?? {})) {
      out.push(String((v as { value?: unknown })?.value ?? v));
    }
  }
  return out.join(" ").slice(0, 100000);
}

/** Rebuild the FTS row for a file from its canonical content JSON. */
export function indexFile(fileId: string, kind: string, content: unknown) {
  const body = extractText(kind, content);
  db.prepare("DELETE FROM search_index WHERE file_id = ?").run(fileId);
  if (body.trim()) {
    db.prepare("INSERT INTO search_index (file_id, body) VALUES (?,?)").run(fileId, body);
  }
}

export function deindexFile(fileId: string) {
  db.prepare("DELETE FROM search_index WHERE file_id = ?").run(fileId);
}

/** One-shot backfill — index every file's head version. Called at boot. */
export function reindexAll() {
  const items = db.prepare("SELECT id, kind FROM items").all() as { id: string; kind: string }[];
  const head = db.prepare("SELECT blob_key FROM versions WHERE file_id = ? ORDER BY number DESC LIMIT 1");
  let n = 0;
  for (const item of items) {
    const v = head.get(item.id) as { blob_key: string } | undefined;
    const blob = v && getBlob(v.blob_key);
    if (!blob) continue;
    try {
      indexFile(item.id, item.kind, JSON.parse(blob.toString("utf8")));
      n++;
    } catch { /* binary blob (e.g. raw PDF v1) — nothing to index */ }
  }
  return n;
}
