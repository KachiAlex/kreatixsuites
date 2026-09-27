import { useState } from "react";
import type { Editor } from "@tiptap/react";
import type { CellBorders } from "./extensions/table";
import { bordersToStyle } from "./extensions/table";

const ALIGN = ["left", "center", "right"] as const;
const VALIGN = ["top", "middle", "bottom"] as const;
const WIDTH_MODES = [
  { k: "auto", label: "Auto (fit contents)" },
  { k: "pct", label: "Percent of page" },
  { k: "fixed", label: "Fixed (column widths)" },
] as const;

type Tab = "table" | "row" | "column" | "cell";

/** Word-style Table Properties dialog — Table / Row / Column / Cell tabs. */
export function TablePropertiesDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const { state } = editor;
  const { $from } = state.selection;
  let tableNode = null as import("@tiptap/pm/model").Node | null;
  let rowNode = null as import("@tiptap/pm/model").Node | null;
  let cellNode = null as import("@tiptap/pm/model").Node | null;
  for (let d = $from.depth; d >= 0; d--) {
    const n = $from.node(d);
    if (n.type.name === "table") tableNode = n;
    if (n.type.name === "tableRow") rowNode = n;
    if (n.type.name === "tableCell" || n.type.name === "tableHeader") cellNode = n;
  }

  const ta = (tableNode?.attrs ?? {}) as Record<string, unknown>;
  const ra = (rowNode?.attrs ?? {}) as Record<string, unknown>;
  const ca = (cellNode?.attrs ?? {}) as Record<string, unknown>;
  const curColWidth = (ca.colwidth as number[] | null)?.[0] ?? null;

  const [tab, setTab] = useState<Tab>("table");
  const [align, setAlign] = useState((ta.align as string) ?? "left");
  const [widthMode, setWidthMode] = useState((ta.widthMode as string) ?? "pct");
  const [widthPct, setWidthPct] = useState<number>((ta.widthPct as number) ?? 100);
  const [indent, setIndent] = useState((ta.indent as number) ?? 0);
  const [repeatHeader, setRepeatHeader] = useState(!!ta.repeatHeader);
  const [rowH, setRowH] = useState<number | "">((ra.height as number) ?? "");
  const [rowMode, setRowMode] = useState((ra.heightMode as string) ?? "atLeast");
  const [cantSplit, setCantSplit] = useState(!!ra.cantSplit);
  const [colW, setColW] = useState<number | "">(curColWidth ?? "");
  const [vAlign, setVAlign] = useState((ca.vAlign as string) ?? "top");
  const [padding, setPadding] = useState<number | "">((ca.padding as number) ?? "");
  const [bg, setBg] = useState((ca.backgroundColor as string) ?? "");
  const borders = ca.borders as CellBorders | null;

  const field = (label: string, children: React.ReactNode) => (
    <label className="ps-field"><span>{label}</span>{children}</label>
  );

  const apply = () => {
    const chain = editor.chain().focus();
    chain.setTableAttributes({
      align: align === "left" ? null : align,
      widthMode, widthPct: widthMode === "pct" ? widthPct : null,
      indent, repeatHeader,
    });
    if (rowH !== "") chain.setRowHeight(Number(rowH), rowMode as "atLeast" | "exact");
    if (cantSplit) chain.command(({ tr, state: s }) => {
      const { $from: f } = s.selection;
      for (let d = f.depth; d >= 0; d--) {
        if (f.node(d).type.name === "tableRow") {
          tr.setNodeMarkup(f.before(d), undefined, { ...f.node(d).attrs, cantSplit: true });
          return true;
        }
      }
      return false;
    });
    chain.setCellAttributes({
      vAlign,
      padding: padding === "" ? null : Number(padding),
      backgroundColor: bg || null,
    });
    if (colW !== "") chain.setColumnWidth(Number(colW));
    chain.run();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Table properties">
        <h3>Table properties</h3>
        <div className="tp-tabs" role="tablist">
          {(["table", "row", "column", "cell"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t}
              className={`tp-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {tab === "table" && (
          <div className="tp-body">
            <div className="ps-row">
              {field("Alignment", (
                <div className="tp-btnrow">
                  {ALIGN.map((a) => (
                    <button key={a} className={`tp-opt ${align === a ? "on" : ""}`} onClick={() => setAlign(a)}>{a}</button>
                  ))}
                </div>
              ))}
            </div>
            <div className="ps-row">
              {field("Width mode", (
                <select value={widthMode} onChange={(e) => setWidthMode(e.target.value)}>
                  {WIDTH_MODES.map((m) => <option key={m.k} value={m.k}>{m.label}</option>)}
                </select>
              ))}
              {widthMode === "pct" && field("Width %", (
                <input type="number" min={10} max={100} value={widthPct}
                  onChange={(e) => setWidthPct(Math.min(100, Math.max(10, Number(e.target.value) || 100)))} />
              ))}
              {field("Indent (steps)", (
                <input type="number" min={0} max={8} value={indent}
                  onChange={(e) => setIndent(Math.max(0, Math.min(8, Number(e.target.value) || 0)))} />
              ))}
            </div>
            <div className="ps-row">
              <label className="ps-check">
                <input type="checkbox" checked={repeatHeader} onChange={(e) => setRepeatHeader(e.target.checked)} />
                Repeat header row at the top of each page
              </label>
            </div>
          </div>
        )}

        {tab === "row" && (
          <div className="tp-body">
            <div className="ps-row">
              {field("Height (px, empty = auto)", (
                <input type="number" min={0} value={rowH} placeholder="auto"
                  onChange={(e) => setRowH(e.target.value === "" ? "" : Math.max(0, Number(e.target.value)))} />
              ))}
              {field("Rule", (
                <select value={rowMode} onChange={(e) => setRowMode(e.target.value)}>
                  <option value="atLeast">At least</option>
                  <option value="exact">Exactly</option>
                </select>
              ))}
            </div>
            <div className="ps-row">
              <label className="ps-check">
                <input type="checkbox" checked={cantSplit} onChange={(e) => setCantSplit(e.target.checked)} />
                Don't split this row across pages
              </label>
            </div>
          </div>
        )}

        {tab === "column" && (
          <div className="tp-body">
            <div className="ps-row">
              {field("Width (px, empty = auto)", (
                <input type="number" min={0} value={colW} placeholder="auto"
                  onChange={(e) => setColW(e.target.value === "" ? "" : Math.max(0, Number(e.target.value)))} />
              ))}
            </div>
            <p className="tp-hint">Applies to the column under the cursor. Drag column borders to resize visually.</p>
          </div>
        )}

        {tab === "cell" && (
          <div className="tp-body">
            <div className="ps-row">
              {field("Vertical align", (
                <div className="tp-btnrow">
                  {VALIGN.map((v) => (
                    <button key={v} className={`tp-opt ${vAlign === v ? "on" : ""}`} onClick={() => setVAlign(v)}>{v}</button>
                  ))}
                </div>
              ))}
            </div>
            <div className="ps-row">
              {field("Cell padding (px)", (
                <input type="number" min={0} value={padding} placeholder="default"
                  onChange={(e) => setPadding(e.target.value === "" ? "" : Math.max(0, Number(e.target.value)))} />
              ))}
              {field("Shading (hex)", (
                <input value={bg} placeholder="#RRGGBB or empty"
                  onChange={(e) => setBg(e.target.value)} />
              ))}
            </div>
            {borders && (
              <p className="tp-hint">Borders: {bordersToStyle(borders)}</p>
            )}
          </div>
        )}

        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}

