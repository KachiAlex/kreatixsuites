import { useState } from "react";

/** Docs/Word-style insert-table grid: hover to preview, click to insert. */
export function TableGridPicker({ onPick, onCustom }: {
  onPick: (rows: number, cols: number) => void;
  onCustom?: () => void;
}) {
  const MAX_R = 10, MAX_C = 8;
  const [hover, setHover] = useState<{ r: number; c: number } | null>(null);
  const r = hover?.r ?? 0, c = hover?.c ?? 0;

  return (
    <div className="tgp" role="dialog" aria-label="Insert table">
      <div className="tgp-grid" onMouseLeave={() => setHover(null)}>
        {Array.from({ length: MAX_R }, (_, ri) => (
          <div className="tgp-row" key={ri}>
            {Array.from({ length: MAX_C }, (_, ci) => (
              <div
                key={ci}
                className={`tgp-cell ${ri < r && ci < c ? "hot" : ""}`}
                onMouseEnter={() => setHover({ r: ri + 1, c: ci + 1 })}
                onClick={() => r && c && onPick(r, c)}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="tgp-foot">
        <span>{r && c ? `${c} × ${r}` : "Insert table"}</span>
        {onCustom && <button className="tgp-custom" onClick={onCustom}>More…</button>}
      </div>
    </div>
  );
}
