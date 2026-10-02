import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { TableMap } from "@tiptap/pm/tables";
import type { SortKey } from "./extensions/table";

const TYPES: { k: SortKey["type"]; label: string }[] = [
  { k: "auto", label: "Auto detect" },
  { k: "text", label: "Text" },
  { k: "number", label: "Number" },
  { k: "date", label: "Date" },
];

const SortBody = ({ editor, onClose, tableNode }: { editor: Editor; onClose: () => void; tableNode: import("@tiptap/pm/model").Node }) => {
  const map = TableMap.get(tableNode);
  const cols = map.width;

  // first row's cells = column labels when it reads as a header row
  const firstRow = tableNode.firstChild;
  const headerDetected = !!firstRow?.childCount && firstRow.firstChild!.type.name === "tableHeader";
  const colNames: string[] = [];
  for (let c = 0; c < cols; c++) {
    let label = "";
    firstRow?.forEach((cell, coff) => {
      const rc = map.findCell(1 + coff);
      const span = (cell.attrs.colspan as number) || 1;
      if (rc.left <= c && c < rc.left + span) {
        const t = cell.textContent.trim();
        if (t && !label) label = t;
      }
    });
    colNames.push(label || `Column ${c + 1}`);
  }

  const [hasHeader, setHasHeader] = useState(headerDetected);
  const [keys, setKeys] = useState<({ enabled: boolean } & SortKey)[]>([
    { enabled: true, col: 0, type: "auto", dir: "asc" },
    { enabled: false, col: cols > 1 ? 1 : 0, type: "auto", dir: "asc" },
    { enabled: false, col: cols > 2 ? 2 : 0, type: "auto", dir: "asc" },
  ]);

  const setKey = (i: number, patch: Partial<SortKey & { enabled: boolean }>) =>
    setKeys((ks) => ks.map((k, j) => (j === i ? { ...k, ...patch } : k)));

  const field = (label: string, children: React.ReactNode) => (
    <label className="ps-field"><span>{label}</span>{children}</label>
  );

  const keyRow = (i: number) => {
    const k = keys[i];
    return (
      <div className="ps-row" key={i} style={{ opacity: i === 0 || k.enabled ? 1 : 0.55 }}>
        {i > 0 && (
          <label className="ps-check" style={{ marginRight: 4 }}>
            <input type="checkbox" checked={k.enabled}
              onChange={(e) => setKey(i, { enabled: e.target.checked })} />
          </label>
        )}
        {field(i === 0 ? "Sort by" : "Then by", (
          <select value={k.col} disabled={i > 0 && !k.enabled}
            onChange={(e) => setKey(i, { col: Number(e.target.value) })}>
            {colNames.map((n, c) => <option key={c} value={c}>{hasHeader ? n : `Column ${c + 1}`}</option>)}
          </select>
        ))}
        {field("Type", (
          <select value={k.type} disabled={i > 0 && !k.enabled}
            onChange={(e) => setKey(i, { type: e.target.value as SortKey["type"] })}>
            {TYPES.map((m) => <option key={m.k} value={m.k}>{m.label}</option>)}
          </select>
        ))}
        {field("Order", (
          <select value={k.dir} disabled={i > 0 && !k.enabled}
            onChange={(e) => setKey(i, { dir: e.target.value as "asc" | "desc" })}>
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        ))}
      </div>
    );
  };

  const apply = () => {
    const active = keys.filter((k, i) => i === 0 || k.enabled)
      .map(({ col, type, dir }) => ({ col, type, dir }));
    editor.chain().focus().sortTableRows("asc", { keys: active, header: hasHeader }).run();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Sort table">
        <h3>Sort table</h3>
        <div className="tp-body">
          {keyRow(0)}
          {keyRow(1)}
          {keyRow(2)}
          <div className="ps-row">
            <label className="ps-check">
              <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
              My table has a header row
            </label>
          </div>
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={apply}>Sort</button>
        </div>
      </div>
    </div>
  );
};

/** Word-style Sort dialog — up to 3 keys, per-column type, header toggle. */
export function SortDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { $from } = editor.state.selection;
  let tableNode = null as import("@tiptap/pm/model").Node | null;
  for (let d = $from.depth; d >= 0; d--) {
    if ($from.node(d).type.name === "table") tableNode = $from.node(d);
  }
  if (!tableNode) { onClose(); return null; }
  return <SortBody editor={editor} onClose={onClose} tableNode={tableNode} />;
}
