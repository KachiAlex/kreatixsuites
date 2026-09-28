import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { FONTS, ensureFont } from "./fonts";
import { allStyleDefs, styleDefOf, type StyleDef } from "./extensions/styles";

const ALIGNS = ["left", "center", "right", "justify"] as const;
const BASES: { key: string; label: string }[] = [
  { key: "paragraph", label: "Paragraph" },
  { key: "h1", label: "Heading 1" }, { key: "h2", label: "Heading 2" },
  { key: "h3", label: "Heading 3" }, { key: "h4", label: "Heading 4" },
  { key: "h5", label: "Heading 5" }, { key: "h6", label: "Heading 6" },
  { key: "blockquote", label: "Quote" },
];

/** Word's "Modify Style" dialog — edit a named style's formatting + next-style. */
export function StyleDialog({ editor, styleKey, onClose }: {
  editor: Editor; styleKey: string; onClose: () => void;
}) {
  const cur = styleDefOf(editor, styleKey) ?? { key: styleKey, label: styleKey, node: "paragraph" as const };
  const isBuiltinBase = !!styleKey;
  const [label, setLabel] = useState(cur.label);
  const [base, setBase] = useState(cur.node === "heading" ? `h${cur.level ?? 1}` : cur.node);
  const [font, setFont] = useState(cur.fontFamily ?? "");
  const [size, setSize] = useState(cur.fontSize ? parseInt(cur.fontSize) : "");
  const [bold, setBold] = useState(cur.bold ?? false);
  const [italic, setItalic] = useState(cur.italic ?? false);
  const [underline, setUnderline] = useState(cur.underline ?? false);
  const [color, setColor] = useState(cur.color ?? "#171717");
  const [align, setAlign] = useState(cur.align ?? "left");
  const [lineH, setLineH] = useState(cur.lineHeight ?? "");
  const [before, setBefore] = useState<number | "">(cur.spaceBefore ?? "");
  const [after, setAfter] = useState<number | "">(cur.spaceAfter ?? "");
  const [indent, setIndent] = useState<number | "">(cur.indent ?? "");
  const [next, setNext] = useState(cur.nextStyle ?? "normal");

  const field = (lbl: string, children: React.ReactNode) => (
    <label className="ps-field"><span>{lbl}</span>{children}</label>
  );

  const save = () => {
    const node = base === "blockquote" ? "blockquote" : base.startsWith("h") ? "heading" : "paragraph";
    const def: Partial<StyleDef> & { key: string } = {
      key: cur.key,
      label: label.trim() || cur.label,
      node,
      level: base.startsWith("h") ? Number(base.slice(1)) : undefined,
      fontFamily: font || undefined,
      fontSize: size === "" ? undefined : `${size}px`,
      bold, italic, underline,
      color: color !== "#171717" ? color : undefined,
      align: align === "left" ? undefined : align,
      lineHeight: lineH || undefined,
      spaceBefore: before === "" ? undefined : Number(before),
      spaceAfter: after === "" ? undefined : Number(after),
      indent: indent === "" ? undefined : Number(indent),
      nextStyle: next || undefined,
    };
    editor.chain().focus().modifyStyle(def).run();
    onClose();
  };

  const nextOptions = allStyleDefs(editor).filter((d) => d.key !== cur.key);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Modify style">
        <h3>Modify style — {cur.label}</h3>
        <div className="tp-body">
          <div className="ps-row">
            {field("Name", <input className="ps-input" value={label} onChange={(e) => setLabel(e.target.value)} disabled={isBuiltinBase} />)}
            {field("Base", (
              <select className="ps-input" value={base} onChange={(e) => setBase(e.target.value)} disabled={isBuiltinBase}>
                {BASES.map((b) => <option key={b.key} value={b.key}>{b.label}</option>)}
              </select>
            ))}
          </div>
          <div className="ps-row">
            {field("Font", (
              <select className="ps-input" value={font} onChange={(e) => { setFont(e.target.value); if (e.target.value) ensureFont(e.target.value); }}>
                <option value="">(default)</option>
                {FONTS.map((f) => <option key={f.label} value={f.family} style={{ fontFamily: f.family }}>{f.label}</option>)}
              </select>
            ))}
            {field("Size", <input className="ps-input" type="number" min={6} max={200} value={size} placeholder="default"
              onChange={(e) => setSize(e.target.value === "" ? "" : Number(e.target.value))} />)}
          </div>
          <div className="ps-row">
            <div className="tp-btnrow">
              <button className={`tp-opt ${bold ? "on" : ""}`} onClick={() => setBold(!bold)}><b>B</b></button>
              <button className={`tp-opt ${italic ? "on" : ""}`} onClick={() => setItalic(!italic)}><i>I</i></button>
              <button className={`tp-opt ${underline ? "on" : ""}`} onClick={() => setUnderline(!underline)}><u>U</u></button>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} title="Text color" className="ps-color" />
            </div>
          </div>
          <div className="ps-row">
            {field("Alignment", (
              <div className="tp-btnrow">
                {ALIGNS.map((a) => <button key={a} className={`tp-opt ${align === a ? "on" : ""}`} onClick={() => setAlign(a)}>{a}</button>)}
              </div>
            ))}
            {field("Line spacing", (
              <select className="ps-input" value={lineH} onChange={(e) => setLineH(e.target.value)}>
                <option value="">(default)</option>
                {["1", "1.15", "1.5", "2", "2.5", "3"].map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            ))}
          </div>
          <div className="ps-row">
            {field("Space before (px)", <input className="ps-input" type="number" min={0} value={before}
              onChange={(e) => setBefore(e.target.value === "" ? "" : Number(e.target.value))} />)}
            {field("Space after (px)", <input className="ps-input" type="number" min={0} value={after}
              onChange={(e) => setAfter(e.target.value === "" ? "" : Number(e.target.value))} />)}
            {field("Indent (steps)", <input className="ps-input" type="number" min={0} max={8} value={indent}
              onChange={(e) => setIndent(e.target.value === "" ? "" : Number(e.target.value))} />)}
          </div>
          <div className="ps-row">
            {field("Style for following paragraph", (
              <select className="ps-input" value={next} onChange={(e) => setNext(e.target.value)}>
                <option value="normal">Normal</option>
                {nextOptions.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
              </select>
            ))}
          </div>
        </div>
        <div className="tp-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={save}>OK</button>
        </div>
      </div>
    </div>
  );
}
