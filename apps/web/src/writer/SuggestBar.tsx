import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  getTrackedChanges, getPendingChangeCount,
  type TrackChangesMode, type TrackedChangeInfo,
} from "tiptap-track-changes";

/** Editing / Suggesting / Viewing mode switcher — compact dropdown, Docs style. */
export function ModeSwitcher({ editor, canEdit, forced }: {
  editor: Editor; canEdit: boolean; forced?: TrackChangesMode;
}) {
  const mode: TrackChangesMode =
    ((editor.storage as unknown as Record<string, { mode?: TrackChangesMode }>).trackChanges?.mode) ?? "edit";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, [open]);
  const set = (m: TrackChangesMode) => {
    (editor.commands as unknown as Record<string, (a?: unknown) => boolean>).setTrackChangesMode(m);
  };
  if (forced === "suggest" && mode !== "suggest") set("suggest");
  const label = mode === "edit" ? "Editing" : mode === "suggest" ? "Suggesting" : "Viewing";
  const icon = mode === "view" ? "👁" : "✎";
  return (
    <div className="rb-drop mode-drop" ref={ref}>
      <button className={`rb rb-dropbtn mode-btn-cur ${open ? "on" : ""}`} title="Editing mode"
        onClick={() => setOpen(!open)}>
        {icon} {label} ▾
      </button>
      {open && (
        <div className="rb-drop-menu mode-menu">
          {(["edit", "suggest", "view"] as const).map((m) => (
            <button key={m} role="menuitemradio" aria-checked={mode === m}
              className={`drop-item ${mode === m ? "on" : ""}`}
              disabled={!canEdit && m !== "view"}
              title={m === "edit" ? "Edit directly" : m === "suggest" ? "Edits become suggestions" : "Read only"}
              onClick={() => { set(m); setOpen(false); }}>
              <span>{m === "edit" ? "✎" : m === "suggest" ? "✎" : "👁"}</span>
              <span>{m === "edit" ? "Editing" : m === "suggest" ? "Suggesting" : "Viewing"}</span>
              {mode === m && <span className="drop-check">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Pending-changes chip + review panel. */
export function SuggestionsBadge({ editor, onOpenPanel }: { editor: Editor; onOpenPanel: () => void }) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const update = () => setCount(getPendingChangeCount(editor));
    update();
    editor.on("transaction", update);
    return () => { editor.off("transaction", update); };
  }, [editor]);
  if (!count) return null;
  return (
    <button className="suggest-badge" onClick={onOpenPanel} title="Review suggestions">
      {count} suggestion{count === 1 ? "" : "s"}
    </button>
  );
}

/** Side panel listing all tracked changes with accept/reject. */
export function SuggestionsPanel({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [changes, setChanges] = useState<TrackedChangeInfo[]>([]);
  useEffect(() => {
    const update = () => setChanges(getTrackedChanges(editor));
    update();
    editor.on("transaction", update);
    return () => { editor.off("transaction", update) };
  }, [editor]);

  const cmd = editor.commands as unknown as Record<string, (...a: any[]) => boolean>;

  return (
    <div className="side-panel">
      <div className="sp-head">
        <h3>Suggestions ({changes.length})</h3>
        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <button className="btn-ghost btn-sm" disabled={!changes.length} onClick={() => cmd.acceptAll()}>Accept all</button>
          <button className="btn-ghost btn-sm" disabled={!changes.length} onClick={() => cmd.rejectAll()}>Reject all</button>
          <button className="sp-close" onClick={onClose}>✕</button>
        </div>
      </div>
      <div className="sp-body">
      {changes.length === 0 && <div className="outline-empty">No pending suggestions</div>}
      {changes.map((c) => (
        <div key={`${c.changeId}-${c.type}`} className="suggest-item">
          <div className="suggest-meta">
            <span className="suggest-author" style={{ color: c.authorColor }}>{c.authorName}</span>
            <span className={`suggest-type t-${c.type}`}>
              {c.type === "insertion" ? "inserted" : c.type === "deletion" ? "deleted" : c.type === "formatChange" ? "reformatted" : "changed"}
            </span>
          </div>
          <div className="suggest-text">“{c.text.slice(0, 90)}{c.text.length > 90 ? "…" : ""}”</div>
          <div className="suggest-btns">
            <button className="rb" title="Jump to change" onClick={() => {
              editor.chain().focus().setTextSelection({ from: c.from, to: Math.min(c.to, editor.state.doc.content.size) }).scrollIntoView().run();
            }}>→</button>
            <button className="btn-ghost btn-sm" onClick={() => cmd.acceptChange(c.changeId)}>Accept</button>
            <button className="btn-ghost btn-sm" onClick={() => cmd.rejectChange(c.changeId)}>Reject</button>
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}
