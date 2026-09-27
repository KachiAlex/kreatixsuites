import { useState } from "react";
import type { BorderSpec, CellBorders } from "./extensions/table";

export interface BorderChoice {
  /** null = clear all borders */
  borders: CellBorders | null;
}

const STYLES = ["solid", "dashed", "dotted", "double"];
const COLORS = ["#3A3633", "#8B8480", "#DDD6D0", "#F2782E", "#3578E5", "#14714A", "#C12E42"];
const WIDTHS = [0.5, 1, 2, 3, 4];

/** Word-style borders popover: presets + per-side toggles + color/width/style. */
export function BordersPicker({ onApply }: { onApply: (b: CellBorders | null) => void }) {
  const [style, setStyle] = useState("solid");
  const [width, setWidth] = useState(1);
  const [color, setColor] = useState("#3A3633");
  const [sides, setSides] = useState<Set<keyof CellBorders>>(new Set());

  const spec = (): BorderSpec => ({ style, width, color });
  const all = (): CellBorders => ({ top: spec(), right: spec(), bottom: spec(), left: spec() });
  const outer = all;
  const inner = (): CellBorders => ({ right: spec(), bottom: spec() });

  const applySides = (s: Set<keyof CellBorders>) => {
    const b: CellBorders = {};
    s.forEach((side) => { b[side] = spec(); });
    onApply(Object.keys(b).length ? b : null);
  };

  const toggle = (side: keyof CellBorders) => {
    const next = new Set(sides);
    if (next.has(side)) next.delete(side); else next.add(side);
    setSides(next);
    applySides(next);
  };

  const preset = (b: CellBorders | null) => { setSides(new Set()); onApply(b); };

  const swatch = (
    <div className="bp-row">
      {COLORS.map((c) => (
        <button key={c} className={`bp-swatch ${color === c ? "on" : ""}`}
          style={{ background: c }} title={c} onClick={() => setColor(c)} />
      ))}
    </div>
  );

  return (
    <div className="bp" role="dialog" aria-label="Table borders">
      <div className="bp-presets">
        <button onClick={() => preset(all())}>All borders</button>
        <button onClick={() => preset(outer())}>Outside</button>
        <button onClick={() => preset(inner())}>Inside</button>
        <button onClick={() => preset(null)}>No border</button>
      </div>
      <div className="bp-sides">
        <span>Sides:</span>
        {(["top", "bottom", "left", "right"] as (keyof CellBorders)[]).map((s) => (
          <button key={s} className={`bp-side ${sides.has(s) ? "on" : ""}`} onClick={() => toggle(s)}>
            {s[0].toUpperCase()}
          </button>
        ))}
      </div>
      <div className="bp-row"><span>Color</span>{swatch}</div>
      <div className="bp-row">
        <span>Width</span>
        {WIDTHS.map((w) => (
          <button key={w} className={`bp-w ${width === w ? "on" : ""}`} onClick={() => setWidth(w)}>{w}</button>
        ))}
      </div>
      <div className="bp-row">
        <span>Style</span>
        {STYLES.map((s) => (
          <button key={s} className={`bp-style ${style === s ? "on" : ""}`} onClick={() => setStyle(s)}>
            <i style={{ borderTop: `3px ${s} #3A3633` }} />
          </button>
        ))}
      </div>
    </div>
  );
}
