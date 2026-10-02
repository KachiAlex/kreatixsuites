import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { FONTS, ensureFont, type FontDef } from "./fonts";
import { allStyleDefs, type StyleDef } from "./extensions/styles";

const TEXT_COLORS = [
  "#171717", "#5F5B56", "#A19A95", "#FFFFFF",
  "#D84B57", "#F2782E", "#F2B51E", "#3E9B4F", "#3B82C4", "#7C5CBF", "#8A5A3B",
];
const HIGHLIGHTS = [
  "#FDE68A", "#FED7AA", "#FECACA", "#FBCFE8", "#DDD6FE",
  "#BFDBFE", "#BAE6FD", "#A7F3D0", "#D9F99D", "#E7E5E4",
];

/** Click-outside-closing dropdown wrapper */
function Drop({ label, title, className, children, width }: {
  label: React.ReactNode; title?: string; className?: string;
  width?: number; children: (close: () => void) => React.ReactNode;
}) {
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
  return (
    <div className={`rb-drop ${className ?? ""}`} ref={ref}>
      <button className={`rb rb-dropbtn ${open ? "on" : ""}`} title={title} onClick={() => setOpen(!open)}>{label} ▾</button>
      {open && <div className="rb-drop-menu" style={width ? { width } : undefined}>{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function FontPicker({ editor, current }: { editor: Editor; current: string }) {
  return (
    <Drop title="Font" className="font-drop" width={220}
      label={<span className="font-label" style={{ fontFamily: current || "Inter" }}>{FONTS.find((f) => current.startsWith(f.family.split(",")[0]))?.label ?? (current ? current.replace(/['"]/g, "").split(",")[0] : "Inter")}</span>}>
      {(close) => (
        <>
          <div className="font-list">
            {FONTS.map((f: FontDef) => (
              <button key={f.label} className={`font-opt ${current === f.family || current.startsWith(f.family.split(",")[0]) ? "on" : ""}`}
                style={{ fontFamily: f.family }}
                onMouseEnter={() => ensureFont(f.family)}
                onClick={() => { ensureFont(f.family); editor.chain().focus().setFontFamily(f.family).run(); close(); }}>
                {f.label}
              </button>
            ))}
          </div>
          <div className="font-custom">
            <input placeholder="More fonts… (Google Fonts)" aria-label="Custom Google Font name"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) { ensureFont(v); editor.chain().focus().setFontFamily(`'${v}'`).run(); close(); }
                }
              }} />
          </div>
        </>
      )}
    </Drop>
  );
}

export function FontSizePicker({ editor, current }: { editor: Editor; current: string }) {
  const size = parseInt(current) || 14;
  return (
    <div className="font-size-ctl">
      <button className="rb" title="Decrease font size" onClick={() => editor.chain().focus().setFontSize(`${Math.max(6, size - 1)}px`).run()}>−</button>
      <input className="font-size-in" value={size} aria-label="Font size"
        onChange={(e) => {
          const v = parseInt(e.target.value);
          if (v >= 6 && v <= 200) editor.chain().focus().setFontSize(`${v}px`).run();
        }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      <button className="rb" title="Increase font size" onClick={() => editor.chain().focus().setFontSize(`${Math.min(200, size + 1)}px`).run()}>+</button>
    </div>
  );
}

export function ColorSwatch({ editor, kind, current }: { editor: Editor; kind: "color" | "highlight"; current: string }) {
  const colors = kind === "color" ? TEXT_COLORS : HIGHLIGHTS;
  return (
    <Drop title={kind === "color" ? "Text color" : "Highlight color"}
      label={kind === "color"
        ? <span style={{ borderBottom: `3px solid ${current || "#171717"}`, paddingBottom: 2 }}>A</span>
        : <span style={{ background: current || "transparent", border: "1px solid var(--line)", padding: "0 4px", borderRadius: 3 }}>▨</span>}>
      {(close) => (
        <div className="swatch-grid">
          {colors.map((c) => (
            <button key={c} className={`swatch ${current === c ? "on" : ""}`} style={{ background: c }}
              title={c}
              onClick={() => {
                if (kind === "color") editor.chain().focus().setColor(c).run();
                else editor.chain().focus().toggleHighlight({ color: c }).run();
                close();
              }} />
          ))}
          <button className="swatch none" title={kind === "color" ? "Default color" : "No highlight"}
            onClick={() => {
              if (kind === "color") editor.chain().focus().unsetColor().run();
              else editor.chain().focus().unsetHighlight().run();
              close();
            }}>✕</button>
        </div>
      )}
    </Drop>
  );
}

export function StylePicker({ editor, current, onModify, onCreate }: {
  editor: Editor; current: string;
  onModify: (key: string) => void; onCreate: () => void;
}) {
  const [, force] = useState(0);
  // re-render when styles change (doc load, modify)
  useEffect(() => {
    const upd = () => force((n) => n + 1);
    editor.on("transaction", upd);
    return () => { editor.off("transaction", upd); };
  }, [editor]);
  const defs = allStyleDefs(editor);
  const cur = defs.find((d) => d.key === current);
  return (
    <Drop title="Styles" className="style-drop" width={240}
      label={<span className="style-label" style={previewStyle(cur)}>{cur?.label ?? "Normal"} ▾</span>}>
      {(close) => (
        <div className="style-list">
          {defs.map((d) => (
            <div key={d.key} className={`style-opt ${current === d.key ? "on" : ""}`}
              onClick={() => { applyStyleSafe(editor, d.key); close(); }}
              title={`${d.label} — right-click Modify`}>
              <span className="style-prev" style={previewStyle(d)}>{d.label}</span>
              <button className="style-mod" title="Modify style…"
                onClick={(e) => { e.stopPropagation(); close(); onModify(d.key); }}>⚙</button>
            </div>
          ))}
          <div className="style-foot">
            <button className="menu-li" onClick={() => { close(); onCreate(); }}>＋ New style from selection…</button>
          </div>
        </div>
      )}
    </Drop>
  );
}

/** Def → inline preview style for the swatch. */
function previewStyle(d: StyleDef | undefined): React.CSSProperties {
  if (!d) return {};
  return {
    fontFamily: d.fontFamily || undefined,
    fontSize: d.fontSize ? Math.min(18, parseInt(d.fontSize)) : undefined,
    fontWeight: d.bold ? 700 : undefined,
    fontStyle: d.italic ? "italic" : undefined,
    textDecoration: d.underline ? "underline" : undefined,
    color: d.color || undefined,
  };
}

function applyStyleSafe(editor: Editor, key: string) {
  editor.chain().focus().applyStyle(key).run();
}

const ZOOMS = [50, 75, 90, 100, 125, 150, 200];

export function ZoomDrop({ zoom, onZoom }: { zoom: number; onZoom: (z: number) => void }) {
  return (
    <Drop title="Zoom" label={<span>{zoom}%</span>}>
      {(close) => (
        <>
          {ZOOMS.map((z) => (
            <button key={z} className={`menu-li ${z === zoom ? "font-opt on" : ""}`}
              onClick={() => { onZoom(z); close(); }}>{z}%</button>
          ))}
          <div className="menu-divider" />
          <button className="menu-li" onClick={() => { onZoom(100); close(); }}>Reset (100%)</button>
        </>
      )}
    </Drop>
  );
}

/** Word-style status bar: page/word counts left, view modes + zoom right. */
export function StatusBar({ editor, words, zoom, onZoom, paged, onTogglePaged, readMode, onReadMode, focusMode, onFocusMode }: {
  editor: Editor; words: number; zoom: number; onZoom: (z: number) => void;
  paged: boolean; onTogglePaged: () => void;
  readMode: boolean; onReadMode: () => void;
  focusMode: boolean; onFocusMode: () => void;
}) {
  const [page, setPage] = useState({ cur: 1, total: 1 });

  useEffect(() => {
    let lastScroll = -1;
    let lastWallCount = -1;
    const measure = (force = false) => {
      if (editor.isDestroyed) return;
      const canvas = document.querySelector(".doc-canvas");
      const scrollTop = canvas?.scrollTop ?? 0;
      const wallCount = editor.view.dom.querySelectorAll(".rm-page-break").length;
      // skip the per-wall rect reads when nothing moved — on a long doc this
      // ran 300+ getBoundingClientRect calls every 800ms while idle
      if (!force && scrollTop === lastScroll && wallCount === lastWallCount) return;
      lastScroll = scrollTop;
      lastWallCount = wallCount;
      const walls = editor.view.dom.querySelectorAll(".rm-page-break");
      if (!walls.length || !paged) { setPage((p) => (p.total === 1 && p.cur === 1 ? p : { cur: 1, total: 1 })); return; }
      const mid = window.innerHeight / 2;
      let cur = 1;
      walls.forEach((w) => { if (w.getBoundingClientRect().top < mid) cur++; });
      const total = walls.length;
      setPage({ cur: Math.min(cur, total), total });
    };
    measure(true);
    const canvas = document.querySelector(".doc-canvas");
    const onScroll = () => measure();
    canvas?.addEventListener("scroll", onScroll, { passive: true });
    const t = setInterval(measure, 800);
    return () => { canvas?.removeEventListener("scroll", onScroll); clearInterval(t); };
  }, [editor, paged]);

  return (
    <div className="status-bar">
      <span className="sb-item">Page {page.cur} of {page.total}</span>
      <span className="sb-item">{words} word{words === 1 ? "" : "s"}</span>
      <span className="sb-spacer" />
      <button className={`sb-btn ${readMode ? "on" : ""}`} title="Read mode" onClick={onReadMode}>📖</button>
      <button className={`sb-btn ${paged ? "on" : ""}`} title="Print layout" onClick={onTogglePaged}>🖺</button>
      <button className={`sb-btn ${focusMode ? "on" : ""}`} title="Focus mode" onClick={onFocusMode}>◎</button>
      <input className="sb-zoom" type="range" min={40} max={250} step={5} value={zoom}
        onChange={(e) => onZoom(parseInt(e.target.value))} title="Zoom" />
      <span className="sb-item sb-zoom-val">{zoom}%</span>
    </div>
  );
}

export function LineSpacingDrop({ editor }: { editor: Editor }) {
  return (
    <Drop title="Line & paragraph spacing" label="↕≡">
      {(close) => (
        <>
          <div className="drop-head">Line spacing</div>
          {["1", "1.15", "1.5", "2", "2.5", "3"].map((v) => (
            <button key={v} className="menu-li" onClick={() => { editor.chain().focus().setLineHeight(v).run(); close(); }}>{v}</button>
          ))}
          <div className="menu-divider" />
          <div className="drop-head">Paragraph spacing</div>
          <button className="menu-li" onClick={() => { editor.chain().focus().setParagraphSpacing(6).run(); close(); }}>Add space above</button>
          <button className="menu-li" onClick={() => { editor.chain().focus().setParagraphSpacing(undefined, 6).run(); close(); }}>Add space below</button>
          <button className="menu-li" onClick={() => { editor.chain().focus().setParagraphSpacing(null, null).run(); close(); }}>Remove spacing</button>
        </>
      )}
    </Drop>
  );
}
