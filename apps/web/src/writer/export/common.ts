/** Shared TipTap-JSON walking helpers for exporters. */

export type Json = Record<string, unknown>;
export interface Mark { type: string; attrs?: Json }
export interface Inline { type: string; text?: string; marks?: Mark[]; attrs?: Json }
export interface Block { type: string; attrs?: Json; content?: (Block | Inline)[]; text?: string; marks?: Mark[] }

export function isText(n: Block | Inline): n is Inline & { text: string } {
  return n.type === "text" && typeof n.text === "string";
}

export function hasMark(n: { marks?: Mark[] }, type: string): Mark | undefined {
  return n.marks?.find((m) => m.type === type);
}

export function textOf(node: Block | Inline): string {
  if (isText(node)) return node.text;
  return ((node as Block).content ?? []).map(textOf).join("");
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}
