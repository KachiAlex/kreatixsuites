import { useState } from "react";
import type { Editor } from "@tiptap/react";

type Mode = "insert" | "delete";

const INSERT_OPTS: { k: string; label: string }[] = [
  { k: "right", label: "Shift cells right" },
  { k: "down", label: "Shift cells down" },
  { k: "row", label: "Insert entire row" },
  { k: "column", label: "Insert entire column" },
];
const DELETE_OPTS: { k: string; label: string }[] = [
  { k: "left", label: "Shift cells left" },
  { k: "up", label: "Shift cells up" },
  { k: "row", label: "Delete entire row" },
  { k: "column", label: "Delete entire column" },
];

/** Word's Insert Table dialog — size + AutoFit behaviour. */
export function InsertTableDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [cols, setCols] = useState(5);
  const [rows, setRows] = useState(2);
  const [fit, setFit] = useState<"fixed" | "contents" | "window">("window");
  const apply = () => {
    editor.chain().focus()
      .insertTable({ rows, cols, withHeaderRow: false })
      .autofitTable(fit)
      .run();
    onClose();
  };
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Insert table">
        <h3>Insert table</h3>
        <div className="tp-body">
          <div className="ps-row">
            <label className="ps-field"><span>Number of columns</span>
              <input type="number" min={1} max={63} value={cols}
                onChange={(e) => setCols(Math.max(1, Math.min(63, Number(e.target.value) || 1)))} />
            </label>
            <label className="ps-field"><span>Number of rows</span>
              <input type="number" min={1} max={200} value={rows}
                onChange={(e) => setRows(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} />
            </label>
          </div>
          <div className="ps-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "#6B645E" }}>AutoFit behavior</span>
            {([
              ["fixed", "Fixed column width"],
              ["contents", "AutoFit to contents"],
              ["window", "AutoFit to window"],
            ] as const).map(([k, lbl]) => (
              <label className="ps-check" key={k}>
                <input type="radio" name="kx-fit" checked={fit === k} onChange={() => setFit(k)} />
                {lbl}
              </label>
            ))}
          </div>
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={apply}>OK</button>
        </div>
      </div>
    </div>
  );
}

/** Word's "Separate text at" picker — tabs / commas / paragraphs / custom. */
export function SeparatorDialog({ title, onApply, onClose }:
  { title: string; onApply: (delim: string) => void; onClose: () => void }) {
  const [kind, setKind] = useState<"tab" | "comma" | "para" | "other">("tab");
  const [other, setOther] = useState(";");
  const delim = kind === "tab" ? "\t" : kind === "comma" ? "," : kind === "para" ? "\n" : (other || ";").slice(0, 1);
  const radio = (k: typeof kind, label: string, extra?: React.ReactNode) => (
    <div className="ps-row">
      <label className="ps-check">
        <input type="radio" name="kx-sep" checked={kind === k} onChange={() => setKind(k)} />
        {label}
      </label>
      {extra}
    </div>
  );
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <h3>{title}</h3>
        <div className="tp-body">
          {radio("para", "Paragraphs")}
          {radio("tab", "Tabs")}
          {radio("comma", "Commas")}
          {radio("other", "Other:", (
            <input type="text" maxLength={1} value={other} disabled={kind !== "other"}
              style={{ width: 32, marginLeft: 6, textAlign: "center" }}
              onChange={(e) => setOther(e.target.value)}
              onFocus={() => setKind("other")} />
          ))}
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => { onApply(delim); onClose(); }}>OK</button>
        </div>
      </div>
    </div>
  );
}

/** Word-style Split Cells dialog — columns × rows counts. */
export function SplitCellsDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [cols, setCols] = useState(2);
  const [rows, setRows] = useState(1);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Split cells">
        <h3>Split cells</h3>
        <div className="tp-body">
          <div className="ps-row">
            <label className="ps-field"><span>Number of columns</span>
              <input type="number" min={1} max={32} value={cols}
                onChange={(e) => setCols(Math.max(1, Math.min(32, Number(e.target.value) || 1)))} />
            </label>
          </div>
          <div className="ps-row">
            <label className="ps-field"><span>Number of rows</span>
              <input type="number" min={1} max={32} value={rows}
                onChange={(e) => setRows(Math.max(1, Math.min(32, Number(e.target.value) || 1)))} />
            </label>
          </div>
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm"
            onClick={() => { editor.chain().focus().splitCellsGrid(cols, rows).run(); onClose(); }}>OK</button>
        </div>
      </div>
    </div>
  );
}

/** Word-style Insert/Delete Cells dialog. Under ProseMirror's uniform grid,
 *  horizontal shifts degenerate to column ops (rows can't be ragged);
 *  vertical shifts cascade cells through the column, extending rowspans. */
export function CellsDialog({ editor, mode, onClose }: { editor: Editor; mode: Mode; onClose: () => void }) {
  const opts = mode === "insert" ? INSERT_OPTS : DELETE_OPTS;
  const [choice, setChoice] = useState(opts[0].k);

  const apply = () => {
    const chain = editor.chain().focus();
    if (mode === "insert") {
      if (choice === "right") chain.addColumnBefore();
      else if (choice === "down") chain.insertCellsDown();
      else if (choice === "row") chain.addRowBefore();
      else chain.addColumnBefore();
    } else {
      if (choice === "left" || choice === "column") chain.deleteColumn();
      else if (choice === "up") chain.deleteCellsUp();
      else chain.deleteRow();
    }
    chain.run();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog"
        aria-label={mode === "insert" ? "Insert cells" : "Delete cells"}>
        <h3>{mode === "insert" ? "Insert cells" : "Delete cells"}</h3>
        <div className="tp-body">
          {opts.map((o) => (
            <div className="ps-row" key={o.k}>
              <label className="ps-check">
                <input type="radio" name="kx-cells" checked={choice === o.k}
                  onChange={() => setChoice(o.k)} />
                {o.label}
              </label>
            </div>
          ))}
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={apply}>OK</button>
        </div>
      </div>
    </div>
  );
}
