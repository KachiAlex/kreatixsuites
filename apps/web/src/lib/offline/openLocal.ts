// Local-file open flow (desktop only): a path handed over by Windows
// (double-click / "Open with" / second-instance) is read through the preload
// bridge, imported into Drive, then routed to the matching editor. Offline,
// the upload falls through to the mirror + outbox and still opens locally.
import { api } from "../api";
import { desktop } from "../platform";
import { b64, store } from "./store";

const KIND_BY_EXT: Record<string, string> = {
  docx: "writer", doc: "writer", odt: "writer", rtf: "writer", txt: "writer",
  xlsx: "sheets", xls: "sheets", csv: "sheets", ods: "sheets",
  pptx: "present", odp: "present",
  pdf: "pdf",
};

const MIME_BY_EXT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  csv: "text/csv",
  txt: "text/plain",
};

export const kindForPath = (p: string): string | null =>
  KIND_BY_EXT[p.split(".").pop()?.toLowerCase() ?? ""] ?? null;

/**
 * Import a local file path into Drive and return the Drive item id to open.
 * Throws with a user-facing message on failure.
 */
export async function importLocalPath(filePath: string): Promise<string> {
  if (!desktop) throw new Error("not desktop");
  const kind = kindForPath(filePath);
  if (!kind) throw new Error(`Kreatix can't open .${filePath.split(".").pop()} files`);

  const r = await desktop.readFile(filePath);
  if (!r.ok || !r.data) throw new Error(`Couldn't read ${r.name ?? filePath}`);

  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const blob = new Blob([b64.from(r.data)], { type: MIME_BY_EXT[ext] ?? "application/octet-stream" });
  const name = r.name ?? filePath.split(/[\\/]/).pop() ?? "document";

  const up = await api.upload<{ item: { id: string } }>(
    `/api/drive/upload?name=${encodeURIComponent(name)}&kind=${kind}`, blob);

  // remember the source path so a later save can offer write-back
  const f = await store.files.get(up.item.id);
  if (f) await store.files.put({ ...f, sourcePath: filePath });
  else await store.files.put({
    id: up.item.id, name, kind, mimeType: blob.type,
    updatedAt: new Date().toISOString(), sourcePath: filePath, synced: !up.item.id.startsWith("local:"),
  });
  return up.item.id;
}
