export function timeAgo(iso: string): string {
  const d = new Date(iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z");
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  if (s < 86400 * 2) return "Yesterday";
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} days ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const KIND_META: Record<string, { label: string; short: string; cls: string }> = {
  writer: { label: "Writer", short: "W", cls: "writer" },
  sheets: { label: "Sheets", short: "S", cls: "sheets" },
  present: { label: "Present", short: "P", cls: "present" },
  pdf: { label: "PDF", short: "PDF", cls: "pdf" },
  file: { label: "File", short: "F", cls: "file-ico" },
  folder: { label: "Folder", short: "▣", cls: "folder-ico" },
};
