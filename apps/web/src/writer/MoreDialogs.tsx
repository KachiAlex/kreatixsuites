import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import { FONTS, ensureFont } from "./fonts";
import { SHAPES, type ShapeKind, type ChartAttrs, parseChartAttrs, chartSvg, shapeSvg, collectIndex } from "./extensions/extras";
import { collectTargets, pageOfPos } from "./extensions/field";
import type { PageSetup } from "./PageSetup";
import { parseCsv } from "../sheets/io";
import { saveFile } from "../lib/saveFile";

const Overlay = ({ children, onClose, wide }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) => (
  <div className="modal-overlay" onClick={onClose}>
    <div className={`modal-card${wide ? " modal-wide" : ""}`} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  </div>
);

/* ================================================================== GO TO */

type GoKind = "page" | "line" | "heading" | "table" | "footnote" | "bookmark";

export function GoToDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [kind, setKind] = useState<GoKind>("page");
  const [num, setNum] = useState("1");
  const [bmk, setBmk] = useState("");

  const counts = useMemo(() => {
    const c = { page: 1, line: 0, heading: 0, table: 0, footnote: 0, bookmark: 0 };
    const walls = editor.view.dom.querySelectorAll(".rm-page-break");
    c.page = walls.length + 1;
    const targets = collectTargets(editor.state.doc);
    c.bookmark = targets.size;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "heading") c.heading++;
      if (node.type.name === "table") c.table++;
      if (node.type.name === "footnote" && node.attrs.kind !== "endnote") c.footnote++;
      if (node.isTextblock) c.line++;
      return true;
    });
    return c;
  }, [editor]);

  const bookmarks = useMemo(() => [...collectTargets(editor.state.doc).keys()], [editor]);

  const go = () => {
    const n = Math.max(1, parseInt(num) || 1);
    if (kind === "page") {
      const walls = editor.view.dom.querySelectorAll(".rm-page-break");
      (n <= 1 ? editor.view.dom : walls[Math.min(n - 2, walls.length - 1)] as HTMLElement | undefined)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
      onClose(); return;
    }
    if (kind === "bookmark") {
      const t = collectTargets(editor.state.doc).get(bmk);
      if (t) editor.chain().focus().setTextSelection(t.pos).scrollIntoView().run();
      onClose(); return;
    }
    // positional kinds — collect matching nodes
    const want = kind === "heading" ? "heading" : kind === "table" ? "table" : kind === "footnote" ? "footnote" : null;
    if (kind === "line") {
      let i = 0, pos: number | null = null;
      editor.state.doc.descendants((node, p) => {
        if (pos != null || !node.isTextblock) return pos == null;
        if (++i === n) pos = p + 1;
        return true;
      });
      if (pos != null) editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
      onClose(); return;
    }
    let i = 0, pos: number | null = null;
    editor.state.doc.descendants((node, p) => {
      if (pos != null) return false;
      if (node.type.name === want && (want !== "footnote" || node.attrs.kind !== "endnote")) {
        if (++i === n) pos = p + 1;
      }
      return true;
    });
    if (pos != null) editor.chain().focus().setTextSelection(pos).scrollIntoView().run();
    onClose();
  };

  const kinds: { k: GoKind; label: string }[] = [
    { k: "page", label: `Page (${counts.page})` },
    { k: "line", label: `Line (${counts.line})` },
    { k: "heading", label: `Heading (${counts.heading})` },
    { k: "table", label: `Table (${counts.table})` },
    { k: "footnote", label: `Footnote (${counts.footnote})` },
    { k: "bookmark", label: `Bookmark (${counts.bookmark})` },
  ];

  return (
    <Overlay onClose={onClose}>
      <h3>Go to</h3>
      <div className="dlg-row">
        <label>Go to what</label>
        <select value={kind} onChange={(e) => setKind(e.target.value as GoKind)}>
          {kinds.map((x) => <option key={x.k} value={x.k}>{x.label}</option>)}
        </select>
      </div>
      {kind === "bookmark" ? (
        <div className="dlg-row">
          <label>Bookmark</label>
          <select value={bmk} onChange={(e) => setBmk(e.target.value)} autoFocus>
            <option value="">— choose —</option>
            {bookmarks.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      ) : (
        <div className="dlg-row">
          <label>Enter {kind === "page" ? "page number" : `${kind} number`}</label>
          <input type="number" min={1} value={num} autoFocus
            onChange={(e) => setNum(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && go()} />
        </div>
      )}
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={go}>Go to</button>
      </div>
    </Overlay>
  );
}

/* ==================================================================== FONT */

const U_STYLES = ["single", "double", "dotted", "dashed", "wavy"] as const;

export function FontDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const a = editor.getAttributes("textStyle");
  const [fontFamily, setFontFamily] = useState((a.fontFamily as string) ?? "");
  const [fontSize, setFontSize] = useState(parseInt(a.fontSize as string) || 14);
  const [color, setColor] = useState((a.color as string) || "#111111");
  const [bold, setBold] = useState(editor.isActive("bold"));
  const [italic, setItalic] = useState(editor.isActive("italic"));
  const [uStyle, setUStyle] = useState<string>((a.uStyle as string) || (editor.isActive("underline") ? "single" : ""));
  const [uColor, setUColor] = useState((a.uColor as string) || "");
  const [strike, setStrike] = useState(editor.isActive("strike") || !!a.dstrike);
  const [dstrike, setDstrike] = useState(!!a.dstrike);
  const [allCaps, setAllCaps] = useState(!!a.allCaps);
  const [smallCaps, setSmallCaps] = useState(!!a.smallCaps);
  const [hidden, setHidden] = useState(!!a.hidden);
  const [spacing, setSpacing] = useState(parseFloat(a.spacing as string) || 0);
  const [fxShadow, setFxShadow] = useState(!!a.fxShadow);
  const [fxOutline, setFxOutline] = useState(!!a.fxOutline);

  const previewStyle: React.CSSProperties = {
    fontFamily: fontFamily || undefined, fontSize: Math.min(28, fontSize),
    fontWeight: bold ? 700 : 400, fontStyle: italic ? "italic" : "normal", color,
    textTransform: allCaps ? "uppercase" : "none",
    fontVariant: smallCaps ? "small-caps" : "normal",
    letterSpacing: spacing ? `${spacing}pt` : undefined,
    textDecoration: [
      uStyle ? `underline ${uStyle === "single" ? "solid" : uStyle}` : "",
      strike ? `line-through ${dstrike ? "double" : ""}` : "",
    ].filter(Boolean).join(" ") || "none",
    textDecorationColor: uColor || undefined,
    textShadow: fxShadow ? "2px 2px 3px rgba(0,0,0,.35)" : undefined,
    WebkitTextStroke: fxOutline ? ".6px currentColor" : undefined,
    ...(fxOutline ? { color: "transparent" } : {}),
  };

  const apply = () => {
    const ch = editor.chain().focus();
    ch.setMark("textStyle", {
      fontFamily: fontFamily || null,
      fontSize: fontSize ? `${fontSize}px` : null,
      color: color || null,
      allCaps: allCaps || null, smallCaps: smallCaps || null,
      hidden: hidden || null,
      spacing: spacing ? `${spacing}pt` : null,
      uStyle: uStyle && uStyle !== "single" ? uStyle : null,
      uColor: uColor || null,
      dstrike: dstrike || null,
      fxShadow: fxShadow || null, fxOutline: fxOutline || null,
    });
    if (uStyle) ch.setUnderline(); else ch.unsetUnderline();
    if (strike && !dstrike) ch.setStrike(); else if (!strike) ch.unsetStrike();
    // bold/italic — sync to checkbox state
    if (bold !== editor.isActive("bold")) ch.toggleBold();
    if (italic !== editor.isActive("italic")) ch.toggleItalic();
    ch.run();
    onClose();
  };

  return (
    <Overlay onClose={onClose} wide>
      <h3>Font</h3>
      <div className="dlg-grid2">
        <div className="dlg-row"><label>Font</label>
          <select value={fontFamily} onChange={(e) => { ensureFont(e.target.value); setFontFamily(e.target.value); }}>
            <option value="">(default)</option>
            {FONTS.map((f) => <option key={f.family} value={f.family}>{f.label}</option>)}
          </select>
        </div>
        <div className="dlg-row"><label>Size</label>
          <input type="number" min={6} max={96} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} />
        </div>
        <div className="dlg-row"><label>Font color</label>
          <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </div>
        <div className="dlg-row"><label>Underline style</label>
          <select value={uStyle} onChange={(e) => setUStyle(e.target.value)}>
            <option value="">(none)</option>
            {U_STYLES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="dlg-row"><label>Underline color</label>
          <input type="color" value={uColor || "#111111"} onChange={(e) => setUColor(e.target.value)} />
        </div>
        <div className="dlg-row"><label>Spacing (pt)</label>
          <input type="number" step={0.5} min={-5} max={20} value={spacing} onChange={(e) => setSpacing(Number(e.target.value))} />
        </div>
      </div>
      <div className="dlg-checks">
        <label><input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} /> Bold</label>
        <label><input type="checkbox" checked={italic} onChange={(e) => setItalic(e.target.checked)} /> Italic</label>
        <label><input type="checkbox" checked={strike} onChange={(e) => { setStrike(e.target.checked); if (!e.target.checked) setDstrike(false); }} /> Strikethrough</label>
        <label><input type="checkbox" checked={dstrike} disabled={!strike} onChange={(e) => setDstrike(e.target.checked)} /> Double strikethrough</label>
        <label><input type="checkbox" checked={allCaps} onChange={(e) => setAllCaps(e.target.checked)} /> All caps</label>
        <label><input type="checkbox" checked={smallCaps} onChange={(e) => setSmallCaps(e.target.checked)} /> Small caps</label>
        <label><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hidden</label>
        <label><input type="checkbox" checked={fxShadow} onChange={(e) => setFxShadow(e.target.checked)} /> Shadow</label>
        <label><input type="checkbox" checked={fxOutline} onChange={(e) => setFxOutline(e.target.checked)} /> Outline</label>
      </div>
      <div className="dlg-preview"><span style={previewStyle}>AaBbYyZz</span></div>
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={apply}>OK</button>
      </div>
    </Overlay>
  );
}

/* =============================================================== TOC OPTS */

export function TocOptionsDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  // edit the selected toc node if there is one
  const sel = editor.state.selection as { node?: { type: { name: string } } };
  const editing = sel.node?.type.name === "toc" ? (sel.node as unknown as { attrs: Record<string, unknown> }).attrs : null;
  const [lo, setLo] = useState(editing ? parseInt((editing.levels as string)[0]) : 1);
  const [hi, setHi] = useState(editing ? parseInt((editing.levels as string).slice(-1)) : 3);
  const [leader, setLeader] = useState<string>((editing?.leader as string) ?? "dots");
  const [pageNums, setPageNums] = useState<boolean>(editing ? editing.pageNums !== false : true);

  const apply = () => {
    const levels = `${Math.min(lo, hi)}-${Math.max(lo, hi)}`;
    const attrs = { levels, leader, pageNums };
    if (editing) editor.chain().focus().updateAttributes("toc", attrs).run();
    else editor.chain().focus().insertContent({ type: "toc", attrs }).run();
    onClose();
  };

  return (
    <Overlay onClose={onClose}>
      <h3>Table of contents options</h3>
      <div className="dlg-row"><label>Show levels</label>
        <div className="dlg-inline">
          <input type="number" min={1} max={6} value={lo} onChange={(e) => setLo(Number(e.target.value))} />
          <span>to</span>
          <input type="number" min={1} max={6} value={hi} onChange={(e) => setHi(Number(e.target.value))} />
        </div>
      </div>
      <div className="dlg-row"><label>Tab leader</label>
        <select value={leader} onChange={(e) => setLeader(e.target.value)}>
          <option value="dots">· · · dots</option>
          <option value="dashes">— — dashes</option>
          <option value="underline">___ underline</option>
          <option value="none">(none)</option>
        </select>
      </div>
      <div className="dlg-checks">
        <label><input type="checkbox" checked={pageNums} onChange={(e) => setPageNums(e.target.checked)} /> Show page numbers</label>
      </div>
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={apply}>{editing ? "Update" : "Insert"}</button>
      </div>
    </Overlay>
  );
}

/* ============================================================ NOTE OPTS */

const NOTE_FMTS = [
  { v: "decimal", label: "1, 2, 3" },
  { v: "lower-alpha", label: "a, b, c" },
  { v: "upper-alpha", label: "A, B, C" },
  { v: "lower-roman", label: "i, ii, iii" },
  { v: "upper-roman", label: "I, II, III" },
];

export function NoteOptionsDialog({ setup, onApply, onClose }:
  { setup: PageSetup; onApply: (s: PageSetup) => void; onClose: () => void }) {
  const [footFmt, setFootFmt] = useState(setup.fnFmt ?? "decimal");
  const [endFmt, setEndFmt] = useState(setup.enFmt ?? "lower-roman");
  const [restart, setRestart] = useState(!!setup.fnRestart);
  return (
    <Overlay onClose={onClose}>
      <h3>Footnote and endnote</h3>
      <div className="dlg-row"><label>Footnote format</label>
        <select value={footFmt} onChange={(e) => setFootFmt(e.target.value)}>
          {NOTE_FMTS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
        </select>
      </div>
      <div className="dlg-row"><label>Endnote format</label>
        <select value={endFmt} onChange={(e) => setEndFmt(e.target.value)}>
          {NOTE_FMTS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}
        </select>
      </div>
      <div className="dlg-checks">
        <label><input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} /> Restart footnotes each page</label>
      </div>
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => { onApply({ ...setup, fnFmt: footFmt, enFmt: endFmt, fnRestart: restart }); onClose(); }}>OK</button>
      </div>
    </Overlay>
  );
}

/* ============================================================ RESTRICT */

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export type RestrictMode = "" | "readonly" | "comments" | "tracked";

export function RestrictDialog({ setup, onApply, onClose }:
  { setup: PageSetup; onApply: (s: PageSetup) => void; onClose: () => void }) {
  const [mode, setMode] = useState<RestrictMode>((setup.restrict as RestrictMode) ?? "");
  const [pwd, setPwd] = useState("");
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    setBusy(true);
    const key = pwd ? await sha256(pwd) : (mode ? (setup.restrictKey ?? "") : "");
    onApply({ ...setup, restrict: mode || undefined, restrictKey: key || undefined, trackingLocked: mode === "tracked" ? true : undefined });
    onClose();
  };
  return (
    <Overlay onClose={onClose}>
      <h3>Restrict editing</h3>
      <div className="dlg-radios">
        <label><input type="radio" name="restr" checked={mode === ""} onChange={() => setMode("")} /> No restriction</label>
        <label><input type="radio" name="restr" checked={mode === "readonly"} onChange={() => setMode("readonly")} /> Read only — no changes allowed</label>
        <label><input type="radio" name="restr" checked={mode === "comments"} onChange={() => setMode("comments")} /> Comments only — text locked, comments allowed</label>
        <label><input type="radio" name="restr" checked={mode === "tracked"} onChange={() => setMode("tracked")} /> Tracked changes — edits must be suggestions</label>
      </div>
      {mode && (
        <div className="dlg-row">
          <label>Password (optional)</label>
          <input type="password" value={pwd} onChange={(e) => setPwd(e.target.value)}
            placeholder={setup.restrictKey ? "Set new password" : "Leave blank for no password"} />
        </div>
      )}
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={busy} onClick={() => void apply()}>Apply</button>
      </div>
    </Overlay>
  );
}

export function UnprotectDialog({ expected, onOk, onClose }: { expected: string; onOk: () => void; onClose: () => void }) {
  const [pwd, setPwd] = useState("");
  const [bad, setBad] = useState(false);
  const tryUnprotect = async () => {
    if (!expected || (await sha256(pwd)) === expected) onOk();
    else setBad(true);
  };
  return (
    <Overlay onClose={onClose}>
      <h3>Unprotect document</h3>
      <div className="dlg-row"><label>Password</label>
        <input type="password" value={pwd} autoFocus onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void tryUnprotect()} />
      </div>
      {bad && <div className="dlg-err">Incorrect password</div>}
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => void tryUnprotect()}>Unprotect</button>
      </div>
    </Overlay>
  );
}

/* =========================================================== EQUATION UI */

const EQ_GROUPS: { name: string; items: [string, string][] }[] = [
  { name: "Operators", items: [["±", "\\pm"], ["×", "\\times"], ["÷", "\\div"], ["·", "\\cdot"], ["∑", "\\sum"], ["∏", "\\prod"], ["∫", "\\int"], ["∂", "\\partial"], ["√", "\\sqrt{}"], ["∞", "\\infty"]] },
  { name: "Relations", items: [["=", "="], ["≠", "\\ne"], ["≈", "\\approx"], ["≤", "\\le"], ["≥", "\\ge"], ["∈", "\\in"], ["⊂", "\\subset"], ["∪", "\\cup"], ["∩", "\\cap"], ["∝", "\\propto"]] },
  { name: "Arrows", items: [["→", "\\to"], ["←", "\\leftarrow"], ["⇒", "\\Rightarrow"], ["⇔", "\\Leftrightarrow"], ["↑", "\\uparrow"], ["↓", "\\downarrow"]] },
  { name: "Greek", items: [["α", "\\alpha"], ["β", "\\beta"], ["γ", "\\gamma"], ["δ", "\\delta"], ["ε", "\\epsilon"], ["θ", "\\theta"], ["λ", "\\lambda"], ["μ", "\\mu"], ["π", "\\pi"], ["σ", "\\sigma"], ["φ", "\\phi"], ["ω", "\\omega"], ["Δ", "\\Delta"], ["Ω", "\\Omega"]] },
  { name: "Structures", items: [["a/b", "\\frac{a}{b}"], ["x²", "x^{2}"], ["xᵢ", "x_{i}"], ["√x", "\\sqrt{x}"], ["∛x", "\\sqrt[3]{x}"], ["lim", "\\lim_{x \\to 0}"], ["∫ab", "\\int_{a}^{b}"], ["∑ⁿ", "\\sum_{i=1}^{n}"], ["( )", "\\left(  \\right)"], ["[ ]", "\\left[  \\right]"]] },
];

/** Symbol/structure palette — appends LaTeX into the selected math node or
 *  creates a new inline math node. */
export function EquationPalette({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const sel = editor.state.selection as { node?: { type: { name: string }; attrs?: Record<string, unknown> } };
  const mathSelected = sel.node?.type.name === "inlineMath" || sel.node?.type.name === "mathInline";
  const [tab, setTab] = useState(0);
  const insert = (latex: string) => {
    if (mathSelected && sel.node) {
      const cur = (sel.node.attrs?.latex as string) ?? (sel.node.attrs?.content as string) ?? "";
      editor.chain().focus().updateAttributes(sel.node.type.name, { latex: cur + latex }).run();
    } else {
      // fall back to whichever math command exists
      const ed = editor as unknown as { commands: Record<string, (...a: unknown[]) => unknown> };
      const fn = ed.commands.insertInlineMath ?? ed.commands.insertMath;
      if (typeof fn === "function") (fn as (a: { latex: string }) => void).call(ed.commands, { latex });
      else editor.chain().focus().insertContent(latex).run();
    }
  };
  return (
    <Overlay onClose={onClose} wide>
      <h3>Equation</h3>
      <div className="dlg-tabs">
        {EQ_GROUPS.map((g, i) => (
          <button key={g.name} className={`dlg-tab${i === tab ? " on" : ""}`} onClick={() => setTab(i)}>{g.name}</button>
        ))}
      </div>
      <div className="eq-grid">
        {EQ_GROUPS[tab].items.map(([label, latex]) => (
          <button key={latex} className="eq-btn" title={latex} onClick={() => insert(latex)}>{label}</button>
        ))}
      </div>
      <div className="dlg-note">{mathSelected ? "Symbols append into the selected equation." : "Each click inserts a new inline equation."}</div>
      <div className="dlg-actions"><button className="btn-primary" onClick={onClose}>Done</button></div>
    </Overlay>
  );
}

/* ================================================================ CHART */

export function ChartDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const sel = editor.state.selection as { node?: { type: { name: string }; attrs?: Record<string, unknown> } };
  const editing = sel.node?.type.name === "chart" ? parseChartAttrs(sel.node.attrs!) : null;
  const [c, setC] = useState<ChartAttrs>(editing ?? {
    ctype: "bar", title: "", labels: ["Q1", "Q2", "Q3", "Q4"],
    series: [{ name: "Series 1", values: [4, 7, 3, 8] }],
  });
  const isPie = c.ctype === "pie" || c.ctype === "doughnut";

  const setSerie = (i: number, patch: Partial<{ name: string; values: string }>) => {
    const s = [...c.series];
    s[i] = {
      name: patch.name ?? s[i].name,
      values: (patch.values !== undefined ? patch.values.split(",").map((x) => Number(x.trim()) || 0) : s[i].values),
    };
    setC({ ...c, series: s });
  };

  const apply = () => {
    const attrs = { ctype: c.ctype, title: c.title, labels: JSON.stringify(c.labels), series: JSON.stringify(c.series) };
    if (editing) editor.chain().focus().updateAttributes("chart", attrs).run();
    else editor.chain().focus().insertContent({ type: "chart", attrs }).run();
    onClose();
  };

  return (
    <Overlay onClose={onClose} wide>
      <h3>Chart</h3>
      <div className="dlg-grid2">
        <div className="dlg-row"><label>Type</label>
          <select value={c.ctype} onChange={(e) => setC({ ...c, ctype: e.target.value as ChartAttrs["ctype"] })}>
            <option value="bar">Bar</option><option value="line">Line</option>
            <option value="pie">Pie</option><option value="doughnut">Doughnut</option>
          </select>
        </div>
        <div className="dlg-row"><label>Title</label>
          <input value={c.title} onChange={(e) => setC({ ...c, title: e.target.value })} />
        </div>
      </div>
      <div className="dlg-row"><label>Labels (comma separated)</label>
        <input value={c.labels.join(", ")} onChange={(e) => setC({ ...c, labels: e.target.value.split(",").map((x) => x.trim()) })} />
      </div>
      {c.series.slice(0, isPie ? 1 : c.series.length).map((s, i) => (
        <div key={i} className="dlg-row">
          <label>Series {i + 1}</label>
          <div className="dlg-inline">
            <input value={s.name} placeholder="name" onChange={(e) => setSerie(i, { name: e.target.value })} />
            <input value={s.values.join(", ")} placeholder="values" onChange={(e) => setSerie(i, { values: e.target.value })} />
            {!isPie && c.series.length > 1 && <button className="btn-ghost btn-sm" onClick={() => setC({ ...c, series: c.series.filter((_, j) => j !== i) })}>✕</button>}
          </div>
        </div>
      ))}
      {!isPie && c.series.length < 6 && (
        <button className="btn-ghost btn-sm" onClick={() => setC({ ...c, series: [...c.series, { name: `Series ${c.series.length + 1}`, values: c.labels.map(() => 0) }] })}>+ Add series</button>
      )}
      <div className="dlg-preview" dangerouslySetInnerHTML={{ __html: chartSvg(c, 480, 220) }} />
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={apply}>{editing ? "Update" : "Insert"}</button>
      </div>
    </Overlay>
  );
}

/* ================================================================ SHAPE */

export function ShapeDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const sel = editor.state.selection as { node?: { type: { name: string }; attrs?: Record<string, unknown> } };
  const editing = sel.node?.type.name === "shape" ? (sel.node.attrs as Record<string, unknown>) : null;
  const [shape, setShape] = useState<ShapeKind>((editing?.shape as ShapeKind) ?? "rect");
  const [w, setW] = useState((editing?.w as number) ?? 180);
  const [h, setH] = useState((editing?.h as number) ?? 100);
  const [fill, setFill] = useState((editing?.fill as string) ?? "#dbeafe");
  const [stroke, setStroke] = useState((editing?.stroke as string) ?? "#1e3a8a");
  const [strokeW, setStrokeW] = useState((editing?.strokeW as number) ?? 2);
  const apply = () => {
    const attrs = { shape, w, h, fill, stroke, strokeW };
    if (editing) editor.chain().focus().updateShape(attrs).run();
    else editor.chain().focus().insertShape(attrs).run();
    onClose();
  };
  return (
    <Overlay onClose={onClose}>
      <h3>Shape</h3>
      <div className="eq-grid eq-shapes">
        {SHAPES.map((s) => (
          <button key={s} className={`eq-btn${s === shape ? " on" : ""}`}
            onClick={() => setShape(s)} title={s}
            dangerouslySetInnerHTML={{ __html: shapeSvgWrap(s) }} />
        ))}
      </div>
      <div className="dlg-grid2">
        <div className="dlg-row"><label>Width</label><input type="number" min={10} value={w} onChange={(e) => setW(Number(e.target.value))} /></div>
        <div className="dlg-row"><label>Height</label><input type="number" min={10} value={h} onChange={(e) => setH(Number(e.target.value))} /></div>
        <div className="dlg-row"><label>Fill</label><input type="color" value={fill} onChange={(e) => setFill(e.target.value)} /></div>
        <div className="dlg-row"><label>Line</label><input type="color" value={stroke} onChange={(e) => setStroke(e.target.value)} /></div>
        <div className="dlg-row"><label>Line width</label><input type="number" min={0} max={12} value={strokeW} onChange={(e) => setStrokeW(Number(e.target.value))} /></div>
      </div>
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={apply}>{editing ? "Update" : "Insert"}</button>
      </div>
    </Overlay>
  );
}

function shapeSvgWrap(s: ShapeKind) { return shapeSvg(s, 44, 30, "#dbeafe", "#1e3a8a", 1.5); }

/* =============================================================== WORDART */

const WA_FX = ["gradient", "outline", "shadow", "slant"] as const;

export function WordArtDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const sel = editor.state.selection as { node?: { type: { name: string }; attrs?: Record<string, unknown> } };
  const editing = sel.node?.type.name === "wordArt" ? (sel.node.attrs as Record<string, unknown>) : null;
  const [text, setText] = useState((editing?.text as string) ?? "Your text");
  const [fx, setFx] = useState((editing?.fx as string) ?? "gradient");
  const [color, setColor] = useState((editing?.color as string) ?? "#F2782E");
  const [size, setSize] = useState((editing?.size as number) ?? 44);
  const apply = () => {
    const attrs = { text, fx, color, size };
    if (editing) editor.chain().focus().updateWordArt(attrs).run();
    else editor.chain().focus().insertWordArt(attrs).run();
    onClose();
  };
  const pv: React.CSSProperties = {
    fontWeight: 800, fontSize: Math.min(size, 54), lineHeight: 1.15,
    ...(fx === "gradient" ? { background: `linear-gradient(180deg,${color} 30%,#fff 55%,${color} 80%)`, WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" } : {}),
    ...(fx === "outline" ? { WebkitTextStroke: "1px currentColor", color: "transparent" } : {}),
    ...(fx === "shadow" ? { color, textShadow: "3px 3px 0 rgba(0,0,0,.3)" } : {}),
    ...(fx === "slant" ? { color, transform: "skewX(-8deg)", display: "inline-block" } : {}),
  };
  return (
    <Overlay onClose={onClose}>
      <h3>WordArt</h3>
      <div className="dlg-row"><label>Text</label><input value={text} autoFocus onChange={(e) => setText(e.target.value)} /></div>
      <div className="dlg-grid2">
        <div className="dlg-row"><label>Style</label>
          <select value={fx} onChange={(e) => setFx(e.target.value)}>
            {WA_FX.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div className="dlg-row"><label>Size</label><input type="number" min={16} max={96} value={size} onChange={(e) => setSize(Number(e.target.value))} /></div>
        <div className="dlg-row"><label>Color</label><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></div>
      </div>
      <div className="dlg-preview"><span style={pv}>{text}</span></div>
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={apply}>{editing ? "Update" : "Insert"}</button>
      </div>
    </Overlay>
  );
}

/* ============================================================ MAIL MERGE */

interface JsonNode { type: string; text?: string; attrs?: Record<string, unknown>; content?: JsonNode[] }

function mergeJson(content: JsonNode[], row: Record<string, string>): JsonNode[] {
  return content.map((n) => {
    const c = { ...n };
    if (c.text) c.text = c.text.replace(/\{\{\s*([\w.-]+)\s*\}\}|«([^»]+)»/g, (_m, a, b) => row[(a ?? b).trim()] ?? _m);
    if (c.content) c.content = mergeJson(c.content, row);
    return c;
  });
}

export function MergeDialog({ editor, initialCsv, onSaveCsv, onClose }:
  { editor: Editor; initialCsv: string; onSaveCsv: (csv: string) => void; onClose: () => void }) {
  const [csv, setCsv] = useState(initialCsv || "Name,Email\nAda Lovelace,ada@example.com\nGrace Hopper,grace@example.com");
  const [recIdx, setRecIdx] = useState(0);
  const [exporting, setExporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const data = useMemo(() => {
    const tbl = parseCsv(csv).filter((r) => r.some((c) => c.trim()));
    if (tbl.length < 2) return { fields: [] as string[], rows: [] as Record<string, string>[] };
    const fields = tbl[0].map((x) => x.trim());
    return {
      fields,
      rows: tbl.slice(1).map((cells) => {
        const r: Record<string, string> = {};
        fields.forEach((f, i) => { r[f] = (cells[i] ?? "").trim(); });
        return r;
      }),
    };
  }, [csv]);
  const row = data.rows[Math.min(recIdx, Math.max(0, data.rows.length - 1))];

  /** merged copies of the template, page-break separated */
  const mergedContent = () => {
    const src = editor.getJSON().content as JsonNode[];
    const out: JsonNode[] = [];
    data.rows.forEach((r, i) => {
      out.push(...mergeJson(JSON.parse(JSON.stringify(src)), r));
      if (i < data.rows.length - 1) out.push({ type: "pageBreak" });
    });
    return out;
  };

  const merge = () => {
    editor.chain().setTextSelection(editor.state.doc.content.size)
      .insertContent([{ type: "pageBreak" }, ...mergedContent()]).run();
    onSaveCsv(csv);
    onClose();
  };

  const exportMerged = async () => {
    setExporting(true);
    try {
      const { exportDocxBytes } = await import("./docx");
      const { readPageSetup } = await import("./PageSetup");
      const blob = await exportDocxBytes({ type: "doc", content: mergedContent() }, "merged",
        { pageSetup: readPageSetup(editor) });
      void saveFile(blob, "merged.docx");
      onSaveCsv(csv);
    } finally { setExporting(false); }
  };

  return (
    <Overlay onClose={onClose} wide>
      <h3>Mail merge</h3>
      <div className="dlg-note">
        Paste CSV below (first row = field names) or load a file. Insert fields as <code>{"{{Name}}"}</code> or <code>«Name»</code> anywhere in the document, then merge.
      </div>
      <div className="dlg-row"><label>Data source (CSV)</label>
        <textarea className="dlg-textarea" rows={6} value={csv} onChange={(e) => setCsv(e.target.value)} />
      </div>
      <div className="dlg-inline">
        <button className="btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>Load .csv…</button>
        <input ref={fileRef} type="file" accept=".csv,.txt" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(setCsv); e.target.value = ""; }} />
        <span className="dlg-note">{data.rows.length} record(s)</span>
      </div>
      {data.fields.length > 0 && (
        <div className="dlg-row">
          <label>Insert field</label>
          <div className="dlg-inline" style={{ flexWrap: "wrap" }}>
            {data.fields.map((f) => (
              <button key={f} className="btn-ghost btn-sm" onClick={() => editor.chain().focus().insertContent(`{{${f}}}`).run()}>{f}</button>
            ))}
          </div>
        </div>
      )}
      {row && (
        <div className="dlg-row">
          <label>Record preview</label>
          <div className="dlg-inline">
            <button className="btn-ghost btn-sm" disabled={recIdx <= 0} onClick={() => setRecIdx(recIdx - 1)}>‹</button>
            <span className="dlg-note">{recIdx + 1} / {data.rows.length}</span>
            <button className="btn-ghost btn-sm" disabled={recIdx >= data.rows.length - 1} onClick={() => setRecIdx(recIdx + 1)}>›</button>
          </div>
          <div className="dlg-note" style={{ marginTop: 4 }}>
            {data.fields.map((f) => <div key={f}><b>{f}:</b> {row[f] || <i>(empty)</i>}</div>)}
          </div>
        </div>
      )}
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={() => { onSaveCsv(csv); onClose(); }}>Cancel</button>
        <button className="btn-ghost" disabled={!data.rows.length || exporting}
          onClick={() => void exportMerged()}>{exporting ? "Exporting…" : "Download .docx"}</button>
        <button className="btn-primary" disabled={!data.rows.length}
          onClick={merge}>Merge to document ({data.rows.length})</button>
      </div>
    </Overlay>
  );
}

/* ============================================================= CITATION */

export function CitationDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [author, setAuthor] = useState("");
  const [year, setYear] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("Book");
  const apply = () => {
    const key = `${author.split(/\s+/)[0] || "ref"}${year}`;
    const display = `(${author}${year ? `, ${year}` : ""})`;
    editor.chain().focus().insertCitation({ key, display, data: JSON.stringify({ author, year, title, kind }) }).run();
    onClose();
  };
  return (
    <Overlay onClose={onClose}>
      <h3>Insert citation</h3>
      <div className="dlg-row"><label>Author</label><input value={author} autoFocus onChange={(e) => setAuthor(e.target.value)} /></div>
      <div className="dlg-row"><label>Year</label><input value={year} onChange={(e) => setYear(e.target.value)} /></div>
      <div className="dlg-row"><label>Title</label><input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="dlg-row"><label>Source type</label>
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          {["Book", "Journal article", "Web site", "Report", "Conference"].map((k) => <option key={k}>{k}</option>)}
        </select>
      </div>
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" disabled={!author} onClick={apply}>Insert</button>
      </div>
    </Overlay>
  );
}

/* ================================================================ INDEX */

export function insertIndexAt(editor: Editor): boolean {
  const map = collectIndex(editor.state.doc, (pos) => pageOfPos(editor.view, pos));
  if (!map.size) return false;
  const letters = [...map.keys()].sort((a, b) => a.localeCompare(b));
  const paras: JsonNode[] = [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Index" }] }];
  for (const entry of letters) {
    const subs = map.get(entry)!;
    const parts: string[] = [];
    for (const [sub, pages] of subs) {
      parts.push(`${sub ? `${entry}: ${sub}` : entry}, ${[...pages].sort((a, b) => a - b).join(", ")}`);
    }
    paras.push({ type: "paragraph", content: [{ type: "text", text: parts.join("; ") }] });
  }
  editor.chain().focus().insertContent(paras).run();
  return true;
}

/* =========================================================== HEADERS/FOOT */

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const CENTER_RE = /<span class="kx-hf-center">([\s\S]*?)<\/span>/;

/** Split a serialized header-left string into its left + center parts. */
function splitLc(html: string): { left: string; center: string } {
  const m = CENTER_RE.exec(html);
  return m ? { left: html.replace(m[0], ""), center: m[1] } : { left: html, center: "" };
}
const joinLc = (l: string, c: string) => l + (c ? `<span class="kx-hf-center">${c}</span>` : "");

function HfEditor({ label, html, onChange }: { label: string; html: string; onChange: (h: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html; }, [html]);
  return (
    <div className="dlg-row">
      <label>{label}</label>
      <div className="hf-edit" ref={ref} contentEditable suppressContentEditableWarning
        onInput={() => onChange(ref.current?.innerHTML ?? "")} />
    </div>
  );
}

interface HfSet { l: string; c: string; r: string }

export function HeaderFooterDialog({ setup, onApply, onClose }:
  { setup: PageSetup; onApply: (s: PageSetup) => void; onClose: () => void }) {
  const hs = splitLc(setup.headerLeft), fs = splitLc(setup.footerLeft);
  const [h, setH] = useState<HfSet>({ l: hs.left, c: hs.center, r: setup.headerRight });
  const [f, setF] = useState<HfSet>({ l: fs.left, c: fs.center, r: setup.footerRight });
  const insertTok = (t: string, which: "h" | "f", part: keyof HfSet) => {
    const set = which === "h" ? setH : setF;
    const cur = (which === "h" ? h : f)[part];
    set({ ...(which === "h" ? h : f), [part]: cur + t });
  };
  const btns = (which: "h" | "f", part: keyof HfSet) => (
    <div className="dlg-inline" style={{ margin: "2px 0 6px 84px" }}>
      <button className="btn-ghost btn-sm" onClick={() => insertTok("{page}", which, part)}>Page #</button>
      <button className="btn-ghost btn-sm" onClick={() => insertTok("{page} of {total}", which, part)}>Page # of #</button>
      <button className="btn-ghost btn-sm" onClick={() => insertTok("<b></b>", which, part)}>Bold…</button>
    </div>
  );
  const row3 = (which: "h" | "f", set: HfSet, setter: (s: HfSet) => void, label: string) => (
    <fieldset className="dlg-fieldset">
      <legend>{label}</legend>
      <HfEditor label="Left" html={set.l} onChange={(v) => setter({ ...set, l: v })} />
      <HfEditor label="Center" html={set.c} onChange={(v) => setter({ ...set, c: v })} />
      <HfEditor label="Right" html={set.r} onChange={(v) => setter({ ...set, r: v })} />
      {btns(which, "c")}
    </fieldset>
  );
  return (
    <Overlay onClose={onClose} wide>
      <h3>Header &amp; footer</h3>
      {row3("h", h, setH, "Header")}
      {row3("f", f, setF, "Footer")}
      <div className="dlg-note">HTML formatting supported (bold, italic, color). Fields: {"{page}"}, {"{total}"}.</div>
      <div className="dlg-actions">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={() => onApply({
          ...setup,
          headerLeft: joinLc(h.l, h.c), headerRight: h.r,
          footerLeft: joinLc(f.l, f.c), footerRight: f.r,
        })}>Apply</button>
      </div>
    </Overlay>
  );
}

export { esc as hfEsc };
