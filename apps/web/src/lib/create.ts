// Shared doc creation — used by the sidebar, command palette, and templates.
import type { DriveItem, FileKind } from "@kreatix/shared";
import { api } from "./api";

const NAMES: Partial<Record<FileKind, string>> = {
  writer: "Untitled document",
  sheets: "Untitled spreadsheet",
  present: "Untitled presentation",
  folder: "New folder",
};

export async function createDoc(kind: FileKind, name?: string, content?: unknown): Promise<DriveItem> {
  const r = await api.post<{ item: DriveItem }>("/api/drive", { name: name ?? NAMES[kind] ?? "Untitled", kind });
  if (content !== undefined) {
    await api.put(`/api/files/${r.item.id}/content`, { content });
  }
  return r.item;
}
