import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { CAPTION_LABELS, collectCaptions, nextRefId } from "./extensions/tof";
import { collectTargets } from "./extensions/field";
import { collectHeadings } from "./extensions/toc";

/** Word ▸ Insert Caption — label + SEQ field + position. */
export function CaptionDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [label, setLabel] = useState<string>("Figure");
  const [custom, setCustom] = useState("");
  const [text, setText] = useState("");
  const [where, setWhere] = useState<"above" | "below">("below");
  const eff = label === "__custom" ? custom.trim() : label;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Caption">
        <h3>Caption</h3>
        <div className="ps-row">
          <label className="ps-field"><span>Label</span>
            <select className="ps-input" value={label} onChange={(e) => setLabel(e.target.value)}>
              {CAPTION_LABELS.map((l) => <option key={l} value={l}>{l}</option>)}
              <option value="__custom">New label…</option>
            </select>
          </label>
          <label className="ps-field"><span>Position</span>
            <select className="ps-input" value={where} onChange={(e) => setWhere(e.target.value as "above" | "below")}>
              <option value="below">Below selected item</option>
              <option value="above">Above selected item</option>
            </select>
          </label>
        </div>
        {label === "__custom" && (
          <div className="ps-row">
            <label className="ps-field grow"><span>Custom label</span>
              <input className="ps-input" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="e.g. Chart" />
            </label>
          </div>
        )}
        <div className="ps-row">
          <label className="ps-field grow"><span>Caption text</span>
            <input className="ps-input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Description…" autoFocus />
          </label>
        </div>
        <div className="tp-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!eff}
            onClick={() => { editor.chain().focus().insertCaption(eff, text, where).run(); onClose(); }}>OK</button>
        </div>
      </div>
    </div>
  );
}

function collectBookmarks(editor: Editor): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  editor.state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name === "bookmark" && m.attrs.id) seen.set(m.attrs.id as string, (m.attrs.name as string) || (m.attrs.id as string));
    }
    return true;
  });
  return [...seen].map(([id, name]) => ({ id, name }));
}

/** Word ▸ Bookmark dialog — list, Add, Delete, Go To. */
export function BookmarkDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [name, setName] = useState("");
  const [, bump] = useState(0);
  const items = collectBookmarks(editor);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Bookmark">
        <h3>Bookmark</h3>
        <div className="ps-row">
          <label className="ps-field grow"><span>Bookmark name</span>
            <input className="ps-input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="select text, then name it" autoFocus />
          </label>
          <button className="btn-primary btn-sm" style={{ alignSelf: "end" }} disabled={!name.trim() || editor.state.selection.empty}
            title={editor.state.selection.empty ? "Select text to bookmark" : ""}
            onClick={() => { editor.chain().focus().setBookmark(name.trim()).run(); setName(""); bump((x) => x + 1); }}>Add</button>
        </div>
        <div className="ps-row" style={{ flexDirection: "column", alignItems: "stretch", maxHeight: 220, overflow: "auto" }}>
          {items.map((b) => (
            <div key={b.id} className="menu-li" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>{b.name}</span>
              <span style={{ display: "flex", gap: 6 }}>
                <button className="btn-ghost btn-sm" onClick={() => { editor.chain().focus().goToBookmark(b.id).scrollIntoView().run(); onClose(); }}>Go To</button>
                <button className="btn-ghost btn-sm" onClick={() => { editor.chain().focus().unsetBookmark(b.id).run(); bump((x) => x + 1); }}>Delete</button>
              </span>
            </div>
          ))}
          {!items.length && <span className="outline-empty">No bookmarks yet — select text, type a name, Add.</span>}
        </div>
        <div className="tp-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

type RefKind = "item" | "heading" | "bookmark";

/** Word ▸ Cross-reference — pick a numbered item / heading / bookmark, insert REF/PAGEREF. */
export function CrossRefDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [kind, setKind] = useState<RefKind>("item");
  const [idx, setIdx] = useState(0);
  const [as, setAs] = useState<"ref" | "pageref">("ref");

  const caps = collectCaptions(editor.state.doc, editor);
  const heads = collectHeadings(editor.state.doc, editor, 1, 6);
  const bms = collectBookmarks(editor);
  const count = kind === "item" ? caps.length : kind === "heading" ? heads.length : bms.length;
  const sel = Math.min(idx, Math.max(0, count - 1));

  const insert = () => {
    const ed = editor.chain().focus();
    let targetId = "";
    if (kind === "item") {
      const c = caps[sel];
      if (!c) return;
      // find the field's id at that pos
      const node = editor.state.doc.nodeAt(c.pos);
      targetId = (node?.attrs.id as string) ?? "";
    } else if (kind === "heading") {
      const h = heads[sel];
      if (!h) return;
      // headings carry no ids — wrap its text in an auto-bookmark (Word parity)
      targetId = nextRefId();
      const $p = editor.state.doc.resolve(h.pos + 1);
      const from = h.pos + 1, to = h.pos + 1 + $p.parent.content.size;
      const mk = editor.state.schema.marks.bookmark.create({ id: targetId, name: h.text });
      ed.command(({ tr }) => { tr.addMark(from, to, mk); return true; });
    } else {
      const b = bms[sel];
      if (!b) return;
      targetId = b.id;
    }
    if (!targetId) return;
    ed.insertField(`${as === "ref" ? "REF" : "PAGEREF"} ${targetId}`).run();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Cross-reference">
        <h3>Cross-reference</h3>
        <div className="ps-row">
          <label className="ps-field"><span>Reference type</span>
            <select className="ps-input" value={kind} onChange={(e) => { setKind(e.target.value as RefKind); setIdx(0); }}>
              <option value="item">Numbered item (captions)</option>
              <option value="heading">Heading</option>
              <option value="bookmark">Bookmark</option>
            </select>
          </label>
          <label className="ps-field"><span>Insert as</span>
            <select className="ps-input" value={as} onChange={(e) => setAs(e.target.value as "ref" | "pageref")}>
              <option value="ref">{kind === "item" ? "Number" : "Text"}</option>
              <option value="pageref">Page number</option>
            </select>
          </label>
        </div>
        <div className="ps-row" style={{ flexDirection: "column", alignItems: "stretch", maxHeight: 220, overflow: "auto" }}>
          {kind === "item" && caps.map((c, i) => (
            <label key={i} className="ps-check"><input type="radio" name="xref" checked={sel === i} onChange={() => setIdx(i)} /> {c.label} {c.num}{c.text ? ` — ${c.text}` : ""}</label>
          ))}
          {kind === "heading" && heads.map((h, i) => (
            <label key={i} className="ps-check"><input type="radio" name="xref" checked={sel === i} onChange={() => setIdx(i)} /> {" ".repeat(h.level - 1)}{h.text}</label>
          ))}
          {kind === "bookmark" && bms.map((b, i) => (
            <label key={i} className="ps-check"><input type="radio" name="xref" checked={sel === i} onChange={() => setIdx(i)} /> {b.name}</label>
          ))}
          {!count && <span className="outline-empty">None found{kind === "item" ? " — insert a caption first" : ""}.</span>}
        </div>
        <div className="tp-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" disabled={!count} onClick={insert}>Insert</button>
        </div>
      </div>
    </div>
  );
}

export { collectTargets };
