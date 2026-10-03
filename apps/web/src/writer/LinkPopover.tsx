import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { safeUrl } from "../lib/sanitize";

/** Floating link editor — appears when the cursor/selection is inside a link. */
export function LinkPopover({ editor }: { editor: Editor }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [href, setHref] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const update = () => {
      if (!editor.isEditable || !editor.isActive("link")) { setPos(null); return; }
      const { from } = editor.state.selection;
      const coords = editor.view.coordsAtPos(from);
      setPos({ x: coords.left, y: coords.bottom });
      setHref((editor.getAttributes("link").href as string) ?? "");
      setEditing(false);
    };
    update();
    editor.on("selectionUpdate", update);
    editor.on("transaction", update);
    return () => {
      editor.off("selectionUpdate", update);
      editor.off("transaction", update);
    };
  }, [editor]);

  if (!pos) return null;
  return (
    <div className="link-pop" style={{ left: pos.x, top: pos.y + 8 }} role="dialog" aria-label="Link">
      {editing ? (
        <>
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
            placeholder="https://…" aria-label="Link URL"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const safe = safeUrl(draft);
                if (safe) editor.chain().focus().setLink({ href: safe }).run();
                setEditing(false);
              } else if (e.key === "Escape") setEditing(false);
            }} />
          <button className="btn-primary btn-sm" onClick={() => { const safe = safeUrl(draft); if (safe) editor.chain().focus().setLink({ href: safe }).run(); setEditing(false); }}>Save</button>
        </>
      ) : (
        <>
          <a href={safeUrl(href) ?? "#"} target="_blank" rel="noopener noreferrer" className="link-pop-url">{href}</a>
          <button className="rb" title="Edit link" onClick={() => { setDraft(href); setEditing(true); }}>✎</button>
          <button className="rb" title="Copy link" onClick={() => void navigator.clipboard.writeText(href)}>⧉</button>
          <button className="rb" title="Remove link" onClick={() => { editor.chain().focus().unsetLink().run(); setPos(null); }}>✕</button>
        </>
      )}
    </div>
  );
}
