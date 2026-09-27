/** Per-kind editor chunk loaders — shared between the lazy() bindings in
 *  Editor.tsx and prefetch calls, so a warmed chunk hits the same module. */

export const editorLoaders = {
  writer: () => import("../writer/WriterEditor").then((m) => ({ default: m.WriterEditor })),
  sheets: () => import("../sheets/SheetsEditor").then((m) => ({ default: m.SheetsEditor })),
  present: () => import("../present/PresentEditor").then((m) => ({ default: m.PresentEditor })),
  pdf: () => import("../pdf/PdfEditor").then((m) => ({ default: m.PdfEditor })),
} as const;

export type EditorKind = keyof typeof editorLoaders;

const prefetched = new Set<string>();

/** Warm an editor chunk ahead of open (row hover / idle after list render). */
export function prefetchEditor(kind: string) {
  if (!(kind in editorLoaders) || prefetched.has(kind)) return;
  prefetched.add(kind);
  void editorLoaders[kind as EditorKind]();
}

/** Idle-prefetch every editor kind present in a file list. */
export function prefetchEditorsFor(kinds: Iterable<string>) {
  const uniq = [...new Set(kinds)].filter((k) => k in editorLoaders && !prefetched.has(k));
  if (!uniq.length) return;
  const run = () => uniq.forEach(prefetchEditor);
  if ("requestIdleCallback" in window) (window as Window).requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}
