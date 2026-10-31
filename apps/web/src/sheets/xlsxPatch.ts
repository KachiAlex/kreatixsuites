// Faithful .xlsx export: patch only the changed cells inside the ORIGINAL
// package. Cell refs (A1) are the identity — values and formulas rebuild in
// place while every style index, sheet part and package part stays untouched.
// Anything this path can't represent throws UnpreservableEditError, and the
// caller refuses instead of silently rebuilding.
import JSZip from "jszip";
import type { Workbook, SheetData, CellData } from "./model";
import { UnpreservableEditError } from "../writer/docxPatch";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const refuse = (why: string): never => { throw new UnpreservableEditError(why); };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const colOf = (ref: string) => ref.replace(/[^A-Z]/gi, "").toUpperCase();
const colN = (c: string) => [...c].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** A rebuilt <c> keeping the original style attribute; formulas lose the cached
 *  <v> so the reader recomputes; text goes inline so sharedStrings is untouched. */
function cellXml(ref: string, sAttr: string, cd: CellData): string {
  let inner = "", t = "";
  if (cd.f) inner = `<f>${esc(cd.f.replace(/^=/, ""))}</f>`;
  else if (cd.v == null) inner = "";
  else if (typeof cd.v === "string") { t = ' t="inlineStr"'; inner = `<is><t xml:space="preserve">${esc(cd.v)}</t></is>`; }
  else if (typeof cd.v === "boolean") { t = ' t="b"'; inner = `<v>${cd.v ? 1 : 0}</v>`; }
  else inner = `<v>${cd.v}</v>`;
  return `<c r="${ref}"${sAttr}${t}>${inner}</c>`;
}

/** <c> elements of a <row>'s inner XML, ref → full element. */
function cellsOf(inner: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of inner.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const r = m[0].match(/\br="([^"]+)"/)?.[1];
    if (r) out.set(r, m[0]);
  }
  return out;
}

function patchSheetXml(xml: string, base: Record<string, CellData>, cur: Record<string, CellData>): { xml: string; touched: boolean } {
  const newByRow = new Map<number, { ref: string; cd: CellData }[]>();
  for (const [ref, cd] of Object.entries(cur)) {
    if (base[ref] == null) {
      const row = +ref.replace(/\D/g, "");
      newByRow.set(row, [...(newByRow.get(row) ?? []), { ref, cd }]);
    }
  }
  let touched = false;
  const handledRows = new Set<number>();
  const out = xml.replace(/<row\b[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, (rowXml) => {
    const rN = +(rowXml.match(/\br="(\d+)"/)?.[1] ?? 0);
    handledRows.add(rN);
    const cells = cellsOf(rowXml);
    const parts: string[] = [];
    const appended = (newByRow.get(rN) ?? []).sort((a, b) => colN(colOf(a.ref)) - colN(colOf(b.ref)));
    for (const [ref, orig] of cells) {
      const bc = base[ref], cc = cur[ref];
      if (bc == null) { parts.push(orig); continue; } // unmodelled original — untouched
      if (cc == null) { touched = true; continue; }   // deleted — cell becomes empty
      if (same(bc, cc)) { parts.push(orig); continue; }
      const { v: _v1, f: _f1, ...bRest } = bc; const { v: _v2, f: _f2, ...cRest } = cc;
      if (!same(bRest, cRest)) refuse(`formatting or metadata changed in cell ${ref}`);
      touched = true;
      const sAttr = orig.match(/\ss="(\d+)"/)?.[0] ?? "";
      parts.push(cellXml(ref, sAttr, cc));
    }
    for (const { ref, cd } of appended) {
      if (cd.s || cd.rt) refuse(`new cell ${ref} carries formatting this path can't map`);
      touched = true;
      parts.push(cellXml(ref, "", cd));
    }
    return rowXml.replace(/(<row\b[^>]*?)(?:\/>|>[\s\S]*?<\/row>)/, `$1>${parts.join("")}</row>`);
  });
  // rows the model has cells for but the XML lacks — only appended at the end,
  // in row order (explicit refs, so nothing renumbers)
  const missing = [...newByRow.keys()].filter((r) => !handledRows.has(r)).sort((a, b) => a - b);
  let result = out;
  for (const rN of missing) {
    const cells = (newByRow.get(rN) ?? []).sort((a, b) => colN(colOf(a.ref)) - colN(colOf(b.ref)));
    for (const { cd } of cells) if (cd.s || cd.rt) refuse("a new row carries formatting this path can't map");
    const xmlRow = `<row r="${rN}">${cells.map(({ ref, cd }) => cellXml(ref, "", cd)).join("")}</row>`;
    const gt = out.match(new RegExp(`<row\\b[^>]*r="(\\d+)"[^>]*?(?=/>|>)`, "g"))
      ?.map((m) => ({ r: +m.match(/r="(\d+)"/)![1], i: out.indexOf(m) }))
      .find((x) => x.r > rN);
    touched = true;
    if (gt) result = result.slice(0, gt.i) + xmlRow + result.slice(gt.i);
    else result = result.replace("</sheetData>", `${xmlRow}</sheetData>`);
  }
  return { xml: result, touched };
}

export async function patchXlsx(source: ArrayBuffer, baseline: Workbook, current: Workbook): Promise<Blob | null> {
  const zip = await JSZip.loadAsync(source);
  const wbXml = await zip.file("xl/workbook.xml")?.async("string");
  const rels = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");
  if (!wbXml || !rels) return refuse("the original file has no readable workbook");
  const bs = (baseline.sheets ?? []) as SheetData[], cs = (current.sheets ?? []) as SheetData[];
  if (bs.length !== cs.length || bs.some((s, i) => s.name !== cs[i]?.name))
    return refuse("sheets were added, removed or renamed");
  const targets = [...wbXml.matchAll(/<sheet\b[^>]*\/>/g)].map((m) => m[0].match(/r:id="([^"]+)"/)?.[1] ?? "");
  const relTarget = (rid: string) => rels.match(new RegExp(`Id="${rid}"[^>]*?Target="([^"]+)"`))?.[1]
    ?? rels.match(new RegExp(`Target="([^"]+)"[^>]*?Id="${rid}"`))?.[1];
  let touched = false;
  for (let i = 0; i < bs.length; i++) {
    // anything outside the cell map (merges, col widths, panes, objects) must be identical
    const { cells: _bc, ...bMeta } = bs[i] as unknown as Record<string, unknown>;
    const { cells: _cc, ...cMeta } = cs[i] as unknown as Record<string, unknown>;
    if (!same(bMeta, cMeta)) return refuse(`sheet "${bs[i].name}" changed outside its cells (layout, merges or settings)`);
    const target = targets[i] && relTarget(targets[i]);
    if (!target) return refuse(`sheet "${bs[i].name}" could not be located in the original file`);
    const path = `xl/${target.replace(/^\/+/, "").replace(/^xl\//, "")}`;
    const sx = await zip.file(path)?.async("string");
    if (!sx) return refuse(`sheet "${bs[i].name}" could not be read`);
    const { xml: out, touched: t } = patchSheetXml(sx, (bs[i].cells ?? {}) as Record<string, CellData>, (cs[i].cells ?? {}) as Record<string, CellData>);
    if (t) { touched = true; zip.file(path, out); }
  }
  if (!touched) return refuse("no change could be applied");
  zip.remove("xl/calcChain.xml"); // stale after cell edits — the reader rebuilds it
  const bytes = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  return new Blob([bytes], { type: XLSX_MIME });
}
