// Local-file open flow: on desktop a path handed over by Windows (double-click,
// "Open with", second-instance, or the open dialog) is read through the preload
// bridge; in the browser/Android shell a <input type=file> picker supplies the
// bytes directly. Either way the file is imported into Drive — offline the
// upload falls through to the mirror + outbox and still opens locally.
import { api } from "../api";
import { desktop } from "../platform";
import { b64, store } from "./store";

const KIND_BY_EXT: Record<string, string> = {
  docx: "writer", docm: "writer", doc: "writer", odt: "writer", rtf: "writer",
  txt: "writer", md: "writer", markdown: "writer", html: "writer", htm: "writer",
  xlsx: "sheets", xlsm: "sheets", xlsb: "sheets", xls: "sheets",
  csv: "sheets", tsv: "sheets", ods: "sheets",
  pptx: "present", pptm: "present", odp: "present",
  pdf: "pdf",
};

const MIME_BY_EXT: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  docm: "application/vnd.ms-word.document.macroEnabled.12",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
  pdf: "application/pdf",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
};

export const kindForPath = (p: string): string | null =>
  KIND_BY_EXT[p.split(".").pop()?.toLowerCase() ?? ""] ?? null;

const ALL_EXTS =
  ".docx,.docm,.doc,.odt,.rtf,.txt,.md,.markdown,.html,.htm," +
  ".xlsx,.xlsm,.xlsb,.xls,.csv,.tsv,.ods,.pptx,.pptm,.odp,.pdf";

/** Upload a picked File into Drive and return the new item's id. */
export async function importLocalFile(f: File): Promise<string> {
  const kind = kindForPath(f.name);
  if (!kind) throw new Error(`Kreatix can't open .${f.name.split(".").pop() ?? "?"} files`);
  const up = await api.upload<{ item?: { id: string } }>(
    `/api/drive/upload?name=${encodeURIComponent(f.name)}&kind=${kind}`, f);
  if (!up?.item?.id) throw new Error("Upload failed — the file wasn't stored in Drive");
  return up.item.id;
}

/** Browser/Android file picker — resolves null when the user cancels. */
export function pickLocalFile(accept = ALL_EXTS): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * "Open from this computer…" — desktop uses the native open dialog +
 * readFile bridge; browser/Android uses a file input. Returns the imported
 * Drive item id, or null when the picker was cancelled. Throws on failure.
 */
export async function openLocalFile(): Promise<string | null> {
  if (desktop) {
    const p = await desktop.openDialog();
    if (!p) return null;
    return importLocalPath(p);
  }
  const f = await pickLocalFile();
  if (!f) return null;
  return importLocalFile(f);
}

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

  const up = await api.upload<{ item?: { id: string } }>(
    `/api/drive/upload?name=${encodeURIComponent(name)}&kind=${kind}`, blob);
  if (!up?.item?.id) throw new Error("Upload failed — the file wasn't stored in Drive");

  // remember the source path so a later save can offer write-back
  const f = await store.files.get(up.item.id);
  if (f) await store.files.put({ ...f, sourcePath: filePath });
  else await store.files.put({
    id: up.item.id, name, kind, mimeType: blob.type,
    updatedAt: new Date().toISOString(), sourcePath: filePath, synced: !up.item.id.startsWith("local:"),
  });
  return up.item.id;
}
