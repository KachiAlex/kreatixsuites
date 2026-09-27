import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  getTrackedChanges, getPendingChangeCount,
  type TrackChangesMode, type TrackedChangeInfo,
} from "tiptap-track-changes";

/** Editing / Suggesting / Viewing mode switcher — Google Docs style. */
export function ModeSwitcher({ editor, canEdit, forced }: {
  editor: Editor; canEdit: boolean; forced?: TrackChangesMode;
}) {
  const mode: TrackChangesMode =
    ((editor.storage as unknown as Record<string, { mode?: TrackChangesMode }>).trackChanges?.mode) ?? "edit";
  const set = (m: TrackChangesMode) => {
    (editor.commands as unknown as Record<string, (a?: unknown) => boolean>).setTrackChangesMode(m);
  };
  if (forced === "suggest" && mode !== "suggest") set("suggest");
  return (
    <div className="mode-switch" role="radiogroup" aria-label="Editing mode">
      {(["edit", "suggest", "view"] as const).map((m) => (
        <button key={m} role="radio" aria-checked={mode === m}
          className={`mode-btn ${mode === m ? "on" : ""}`}
          disabled={!canEdit && m !== "view"}
          title={m === "edit" ? "Edit directly" : m === "suggest" ? "Edits become suggestions" : "Read only"}
          onClick={() => set(m)}>
          {m === "edit" ? "✎ Editing" : m === "suggest" ? "✎ Suggesting" : "👁 Viewing"}
        </button>
      ))}
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
