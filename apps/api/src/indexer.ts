// Search indexer — extracts plain text from each doc kind's canonical JSON
// (plus PDF body text server-side via pdf.js) and stores it in search_index.
// Bodies are AES-256-GCM encrypted when KREATIX_DATA_KEY is set; matching runs
// JS-side over permission-scoped candidates in routes/search.ts.
import { db } from "./db.js";
import { getBlob } from "./blobs.js";
import { encryptField, decryptField } from "./crypto.js";

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

/** Extract embedded text from raw PDF bytes (Node legacy build, no worker). */
async function extractPdfText(pdfBytes: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(pdfBytes) } as never);
  const doc = await task.promise;
  const parts: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    for (const item of tc.items) {
      if ("str" in item) parts.push(item.str);
    }
  }
  void task.destroy();
  return parts.join(" ");
}

/**
 * Rebuild the index row for a file. For PDFs, also extracts the raw document's
 * embedded text (version 1 blob) alongside annotation/form text.
 */
export async function indexFile(fileId: string, kind: string, content: unknown) {
  let body = extractText(kind, content);
  if (kind === "pdf") {
    const v1 = db
      .prepare("SELECT blob_key FROM versions WHERE file_id = ? ORDER BY number ASC LIMIT 1")
      .get(fileId) as { blob_key: string } | undefined;
    const raw = v1 && getBlob(v1.blob_key);
    if (raw && raw.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
      try {
        body = `${body} ${await extractPdfText(raw)}`.trim();
      } catch (err) {
        console.warn("[pdf-index]", err instanceof Error ? err.message : err);
      }
    }
  }
  db.prepare("DELETE FROM search_index WHERE file_id = ?").run(fileId);
  if (body.trim()) {
    db.prepare("INSERT INTO search_index (file_id, body) VALUES (?,?)").run(fileId, encryptField(body)!);
  }
}

export function deindexFile(fileId: string) {
  db.prepare("DELETE FROM search_index WHERE file_id = ?").run(fileId);
}

/** Decrypted index body for a file (used by search + DLP checks). */
export function indexBody(fileId: string): string {
  const row = db.prepare("SELECT body FROM search_index WHERE file_id = ?").get(fileId) as
    | { body: string }
    | undefined;
  return decryptField(row?.body ?? null) ?? "";
}

/** One-shot backfill — index every file's head version. Called at boot. */
export async function reindexAll() {
  const items = db.prepare("SELECT id, kind FROM items").all() as { id: string; kind: string }[];
  const head = db.prepare("SELECT blob_key FROM versions WHERE file_id = ? ORDER BY number DESC LIMIT 1");
  let n = 0;
  for (const item of items) {
    const v = head.get(item.id) as { blob_key: string } | undefined;
    const blob = v && getBlob(v.blob_key);
    if (!blob) continue;
    let content: unknown = null;
    try {
      content = JSON.parse(blob.toString("utf8"));
    } catch { /* binary blob */ }
    if (content === null && item.kind !== "pdf") continue;
    try {
      await indexFile(item.id, item.kind, content);
      n++;
    } catch { /* indexing is best-effort */ }
  }
  return n;
}
