import { useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import type { TabStop, ParaBorders } from "./extensions/paraFormat";

type Tab = "indents" | "breaks" | "borders" | "tabs";
const BORDER_STYLES = ["single", "double", "dashed", "dotted"] as const;
const TAB_ALIGN = ["left", "center", "right", "decimal"] as const;
const LEADERS = ["none", "dot", "dash", "line"] as const;

/** Word ▸ Paragraph dialog — indents, spacing, breaks, borders, tab stops. */
export function ParagraphDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("indents");
  const attrs = editor.state.selection.$from.parent.attrs as Record<string, unknown>;

  const num = (v: unknown): number | "" => (v == null || v === "" ? "" : Number(v));
  const [indL, setIndL] = useState<number | "">(num(attrs.indentPx) || (attrs.indent ? (attrs.indent as number) * 24 : ""));
  const [indR, setIndR] = useState<number | "">(num(attrs.indentRight));
  const [special, setSpecial] = useState<"none" | "first" | "hanging">(
    attrs.firstLine == null ? "none" : (attrs.firstLine as number) >= 0 ? "first" : "hanging");
  const [specialBy, setSpecialBy] = useState<number | "">(attrs.firstLine ? Math.abs(attrs.firstLine as number) : 14);
  const [before, setBefore] = useState<number | "">(num(attrs.spaceBefore));
  const [after, setAfter] = useState<number | "">(num(attrs.spaceAfter));
  const rule = (attrs.lineSpacingRule as string | null) ?? null;
  const [lsMode, setLsMode] = useState<"multiple" | "exact" | "atLeast">(
    rule?.startsWith("exact:") ? "exact" : rule?.startsWith("atLeast:") ? "atLeast" : "multiple");
  const [lsVal, setLsVal] = useState<string>(rule?.split(":")[1] ?? "1.15");
  const [keepNext, setKeepNext] = useState(!!attrs.keepNext);
  const [keepLines, setKeepLines] = useState(!!attrs.keepLines);
  const [pageBreakBefore, setPageBreakBefore] = useState(!!attrs.pageBreakBefore);
  const [widowOrphan, setWidowOrphan] = useState(!!attrs.widowOrphan);
  const [shading, setShading] = useState<string>((attrs.pShading as string) ?? "");
  const [borders, setBorders] = useState<ParaBorders>((attrs.pBorders as ParaBorders) ?? {});
  const [bStyle, setBStyle] = useState<string>("single");
  const [bWidth, setBWidth] = useState(1);
  const [bColor, setBColor] = useState("#171717");
  const [tabs, setTabs] = useState<TabStop[]>((attrs.tabs as TabStop[]) ?? []);
  const [tabPos, setTabPos] = useState<number | "">(96);
  const [tabAlign, setTabAlign] = useState<TabStop["align"]>("left");
  const [tabLeader, setTabLeader] = useState<TabStop["leader"]>("none");

  const field = (lbl: string, children: ReactNode) => (
    <label className="ps-field"><span>{lbl}</span>{children}</label>
  );

  const apply = () => {
    const spec = special === "none" ? null : (special === "first" ? 1 : -1) * (specialBy === "" ? 14 : Number(specialBy));
    const out: Record<string, unknown> = {
      indentPx: indL === "" ? null : Number(indL),
      indentRight: indR === "" ? null : Number(indR),
      firstLine: spec,
      spaceBefore: before === "" ? null : Number(before),
      spaceAfter: after === "" ? null : Number(after),
      lineSpacingRule: `${lsMode}:${lsVal}`,
      keepNext: keepNext || null,
      keepLines: keepLines || null,
      pageBreakBefore: pageBreakBefore || null,
      widowOrphan: widowOrphan || null,
      pBorders: Object.values(borders).some(Boolean) ? borders : null,
      pShading: shading || null,
      tabs: tabs.length ? tabs : null,
    };
    editor.chain().focus().setParaFormat(out).run();
    onClose();
  };

  const setBorder = (side: keyof ParaBorders, on: boolean) => {
    setBorders((b) => ({ ...b, [side]: on ? { style: bStyle, width: bWidth, color: bColor } : undefined }));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Paragraph">
        <h3>Paragraph</h3>
        <div className="tp-tabs" role="tablist">
          {(["indents", "breaks", "borders", "tabs"] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t}
              className={`tp-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
              {{ indents: "Indents & Spacing", breaks: "Line & Page Breaks", borders: "Borders", tabs: "Tabs" }[t]}
            </button>
          ))}
        </div>

        {tab === "indents" && (
          <div className="tp-body">
            <div className="ps-row">
              {field("Left indent (px)", <input className="ps-input" type="number" min={0} value={indL} onChange={(e) => setIndL(e.target.value === "" ? "" : Number(e.target.value))} />)}
              {field("Right indent (px)", <input className="ps-input" type="number" min={0} value={indR} onChange={(e) => setIndR(e.target.value === "" ? "" : Number(e.target.value))} />)}
            </div>
            <div className="ps-row">
              {field("Special", (
                <select className="ps-input" value={special} onChange={(e) => setSpecial(e.target.value as typeof special)}>
                  <option value="none">(none)</option>
                  <option value="first">First line</option>
                  <option value="hanging">Hanging</option>
                </select>
              ))}
              {field("By (px)", <input className="ps-input" type="number" min={1} value={specialBy} disabled={special === "none"}
                onChange={(e) => setSpecialBy(e.target.value === "" ? "" : Number(e.target.value))} />)}
            </div>
            <div className="ps-row">
              {field("Space before (px)", <input className="ps-input" type="number" min={0} value={before} onChange={(e) => setBefore(e.target.value === "" ? "" : Number(e.target.value))} />)}
              {field("Space after (px)", <input className="ps-input" type="number" min={0} value={after} onChange={(e) => setAfter(e.target.value === "" ? "" : Number(e.target.value))} />)}
            </div>
            <div className="ps-row">
              {field("Line spacing", (
                <select className="ps-input" value={lsMode} onChange={(e) => setLsMode(e.target.value as typeof lsMode)}>
                  <option value="multiple">Multiple</option>
                  <option value="exact">Exactly</option>
                  <option value="atLeast">At least</option>
                </select>
              ))}
              {field(lsMode === "multiple" ? "Multiple of" : "Points (pt)", (
                lsMode === "multiple"
                  ? <select className="ps-input" value={lsVal} onChange={(e) => setLsVal(e.target.value)}>
                      {["1", "1.08", "1.15", "1.5", "2", "2.5", "3"].map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  : <input className="ps-input" type="number" min={1} value={lsVal} onChange={(e) => setLsVal(e.target.value)} />
              ))}
            </div>
          </div>
        )}

        {tab === "breaks" && (
          <div className="tp-body">
            <div className="ps-row"><label className="ps-check"><input type="checkbox" checked={widowOrphan} onChange={(e) => setWidowOrphan(e.target.checked)} /> Widow/Orphan control</label></div>
            <div className="ps-row"><label className="ps-check"><input type="checkbox" checked={keepLines} onChange={(e) => setKeepLines(e.target.checked)} /> Keep lines together</label></div>
            <div className="ps-row"><label className="ps-check"><input type="checkbox" checked={keepNext} onChange={(e) => setKeepNext(e.target.checked)} /> Keep with next</label></div>
            <div className="ps-row"><label className="ps-check"><input type="checkbox" checked={pageBreakBefore} onChange={(e) => setPageBreakBefore(e.target.checked)} /> Page break before</label></div>
          </div>
        )}

        {tab === "borders" && (
          <div className="tp-body">
            <div className="ps-row">
              {field("Style", (
                <select className="ps-input" value={bStyle} onChange={(e) => setBStyle(e.target.value)}>
                  {BORDER_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              ))}
              {field("Width (px)", <input className="ps-input" type="number" min={1} max={8} value={bWidth} onChange={(e) => setBWidth(Number(e.target.value))} />)}
              {field("Color", <input type="color" className="ps-color" value={bColor} onChange={(e) => setBColor(e.target.value)} />)}
            </div>
            <div className="ps-row">
              {(["top", "right", "bottom", "left"] as const).map((s) => (
                <label key={s} className="ps-check">
                  <input type="checkbox" checked={!!borders[s]} onChange={(e) => setBorder(s, e.target.checked)} /> {s}
                </label>
              ))}
            </div>
            <div className="ps-row">
              {field("Shading (fill)", (
                <>
                  <input type="color" className="ps-color" value={shading || "#ffffff"} onChange={(e) => setShading(e.target.value)} />
                  {shading && <button className="btn-ghost btn-sm" onClick={() => setShading("")}>Clear</button>}
                </>
              ))}
            </div>
          </div>
        )}

        {tab === "tabs" && (
          <div className="tp-body">
            <div className="ps-row">
              {field("Position (px)", <input className="ps-input" type="number" min={1} value={tabPos} onChange={(e) => setTabPos(e.target.value === "" ? "" : Number(e.target.value))} />)}
              {field("Alignment", (
                <select className="ps-input" value={tabAlign} onChange={(e) => setTabAlign(e.target.value as TabStop["align"])}>
                  {TAB_ALIGN.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              ))}
              {field("Leader", (
                <select className="ps-input" value={tabLeader} onChange={(e) => setTabLeader(e.target.value as TabStop["leader"])}>
                  {LEADERS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              ))}
            </div>
            <div className="ps-row">
              <button className="btn-ghost btn-sm" onClick={() => {
                if (tabPos === "") return;
                setTabs((t) => [...t.filter((x) => x.pos !== Number(tabPos)), { pos: Number(tabPos), align: tabAlign, leader: tabLeader }].sort((a, b) => a.pos - b.pos));
              }}>Set</button>
              <button className="btn-ghost btn-sm" onClick={() => setTabs([])} disabled={!tabs.length}>Clear all</button>
            </div>
            <div className="ps-row" style={{ flexDirection: "column", alignItems: "stretch" }}>
              {tabs.map((t) => (
                <div key={t.pos} className="menu-li" style={{ display: "flex", justifyContent: "space-between" }}>
                  <span>{t.pos}px — {t.align}{t.leader !== "none" ? ` (${t.leader})` : ""}</span>
                  <button className="style-mod" style={{ opacity: 1 }} onClick={() => setTabs((x) => x.filter((y) => y !== t))}>✕</button>
                </div>
              ))}
              {!tabs.length && <span className="outline-empty">No custom stops — default is every 48px.</span>}
            </div>
          </div>
        )}

        <div className="tp-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={apply}>OK</button>
        </div>
      </div>
    </div>
  );
}
