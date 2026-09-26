// ../web/src/sheets/model.ts
var ROW_H = 26;
var COL_W = 100;
var HEADER_W = 42;
function colLabel(n) {
  let s = "";
  n += 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function colIndex(label) {
  let n = 0;
  for (const ch of label.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
var toA1 = (c, r) => `${colLabel(c)}${r + 1}`;
function parseA1(ref) {
  const m = /^\$?([A-Za-z]+)\$?(\d+)$/.exec(ref.trim());
  if (!m) return null;
  return { col: colIndex(m[1]), row: Number(m[2]) - 1 };
}
function parseRange(ref) {
  const parts = ref.split(":");
  if (parts.length === 1) {
    const a2 = parseA1(parts[0]);
    return a2 ? { c1: a2.col, r1: a2.row, c2: a2.col, r2: a2.row } : null;
  }
  const a = parseA1(parts[0]);
  const b = parseA1(parts[1]);
  if (!a || !b) return null;
  return {
    c1: Math.min(a.col, b.col),
    r1: Math.min(a.row, b.row),
    c2: Math.max(a.col, b.col),
    r2: Math.max(a.row, b.row)
  };
}
function rangeToA1(r) {
  return r.c1 === r.c2 && r.r1 === r.r2 ? toA1(r.c1, r.r1) : `${toA1(r.c1, r.r1)}:${toA1(r.c2, r.r2)}`;
}
function* rangeRefs(r) {
  for (let row = r.r1; row <= r.r2; row++)
    for (let col = r.c1; col <= r.c2; col++) yield toA1(col, row);
}
function parseInput(raw) {
  const t = raw.trim();
  if (t === "") return {};
  if (t.startsWith("=")) return { f: t.slice(1) };
  if (/^-?[\d,]*\.?\d+%$/.test(t)) return { v: Number(t.replace(/[%,]/g, "")) / 100 };
  if (/^-?[\d,]*\.?\d+$/.test(t)) return { v: Number(t.replace(/,/g, "")) };
  if (/^(true|false)$/i.test(t)) return { v: /^t/i.test(t) };
  return { v: raw };
}
function cellEditText(c) {
  if (!c) return "";
  if (c.f) return `=${c.f}`;
  return c.v === null || c.v === void 0 ? "" : String(c.v);
}
function mergeAt(merges, c, r) {
  return merges?.find((m) => c >= m.c1 && c <= m.c2 && r >= m.r1 && r <= m.r2);
}
function translateFormula(f, map) {
  return f.replace(
    /(?<![A-Za-z0-9_$!:])(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?!\s*\()/g,
    (_m, dc, cl, dr, rn) => {
      const out = map({ col: colIndex(cl), row: Number(rn) - 1, colAbs: !!dc, rowAbs: !!dr });
      return out === null ? "#REF!" : `${dc}${colLabel(out.col)}${dr}${out.row + 1}`;
    }
  );
}
function shiftForFill(f, dCol, dRow) {
  return translateFormula(f, (r) => ({
    col: r.colAbs ? r.col : Math.max(0, r.col + dCol),
    row: r.rowAbs ? r.row : Math.max(0, r.row + dRow)
  }));
}
function axisShift(axis, at, count, band) {
  return (p) => {
    const pos = axis === "row" ? p.row : p.col;
    if (band === "insert") {
      return pos >= at ? { ...p, [axis]: pos + count } : p;
    }
    if (pos >= at && pos < at - count) return null;
    return pos >= at - count ? { ...p, [axis]: pos + count } : p;
  };
}
function shiftRangeA1(rangeA1, map) {
  const [a, b] = rangeA1.split(":");
  const pa = parseA1(a);
  const pb = b ? parseA1(b) : pa;
  if (!pa || !pb) return rangeA1;
  const na = map(pa);
  const nb = map(pb);
  if (!na || !nb) return null;
  return na.col === nb.col && na.row === nb.row ? toA1(na.col, na.row) : `${toA1(na.col, na.row)}:${toA1(nb.col, nb.row)}`;
}
function adjustForRowsCols(sheet, axis, at, count) {
  const band = count > 0 ? "insert" : "delete";
  const map = axisShift(axis, at, count, band);
  const cells = {};
  for (const [ref, cell] of Object.entries(sheet.cells)) {
    const p = parseA1(ref);
    const np = map(p);
    if (np) cells[toA1(np.col, np.row)] = cell;
  }
  sheet.cells = cells;
  for (const cell of Object.values(sheet.cells)) {
    if (cell.f) cell.f = translateFormula(cell.f, (r) => map({ col: r.col, row: r.row }));
  }
  sheet.merges = (sheet.merges ?? []).map((m) => {
    const a = map({ col: m.c1, row: m.r1 });
    const b = map({ col: m.c2, row: m.r2 });
    if (!a || !b) return null;
    return { c1: Math.min(a.col, b.col), r1: Math.min(a.row, b.row), c2: Math.max(a.col, b.col), r2: Math.max(a.row, b.row) };
  }).filter((m) => !!m);
  sheet.cf = (sheet.cf ?? []).map((r) => {
    const nr = shiftRangeA1(r.range, map);
    return nr ? { ...r, range: nr } : null;
  }).filter((r) => !!r);
  for (const ch of sheet.charts ?? []) {
    const nr = shiftRangeA1(ch.range, map);
    if (nr) ch.range = nr;
  }
}
export {
  COL_W,
  HEADER_W,
  ROW_H,
  adjustForRowsCols,
  cellEditText,
  colIndex,
  colLabel,
  mergeAt,
  parseA1,
  parseInput,
  parseRange,
  rangeRefs,
  rangeToA1,
  shiftForFill,
  toA1,
  translateFormula
};
