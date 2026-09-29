// ---------- S18.3 Get & Transform — Power Query-equivalent ----------
// A QuerySpec describes a connect → transform → load pipeline. Sources are
// pasted text or URLs (CSV/TSV/JSON); steps are a JSON-editable transform
// chain; results load into a sheet that Refresh can regenerate.

import type { QuerySpec, QueryStep, SheetData, CellData, Workbook } from "./model";
import { toA1, parseInput } from "./model";

export interface QueryResult { headers: string[]; rows: unknown[][] }

/** Delimited-text parser (RFC-4180-ish quoting), delimiter-configurable. */
export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [], field = "", inQ = false;
  for (let i = 0; i <= text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { cur.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r" || i === text.length) {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      cur.push(field); field = "";
      rows.push(cur); cur = [];
    } else field += ch;
  }
  while (rows.length && rows[rows.length - 1].every((c) => c === "")) rows.pop();
  return rows;
}

/** Resolve a JSON source: array of objects/arrays, or a nested array at
 *  `jsonPath` ("a.b[0].items" style). Objects → union-of-keys header + rows. */
export function jsonToTable(data: unknown, path?: string): { headers: string[]; rows: unknown[][] } {
  let node: unknown = data;
  if (path) {
    for (const seg of path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean)) {
      node = (node as Record<string, unknown>)?.[seg];
      if (node === undefined) throw new Error(`jsonPath "${path}" not found`);
    }
  }
  if (!Array.isArray(node)) throw new Error("JSON source must resolve to an array");
  if (!node.length) return { headers: [], rows: [] };
  if (Array.isArray(node[0])) {
    const rows = node as unknown[][];
    return { headers: rows[0].map(String), rows: rows.slice(1) };
  }
  const headers = [...new Set(node.flatMap((o) => Object.keys(o as object)))];
  return { headers, rows: node.map((o) => headers.map((h) => (o as Record<string, unknown>)[h] ?? null)) };
}

async function sourceText(src: QuerySpec["source"]): Promise<string> {
  if (src.text !== undefined) return src.text;
  if (!src.url) throw new Error("Query source needs text or a URL");
  const r = await fetch(src.url);
  if (!r.ok) throw new Error(`Fetch failed: HTTP ${r.status}`);
  return r.text();
}

export async function runQuery(spec: QuerySpec): Promise<QueryResult> {
  let headers: string[] = [];
  let rows: unknown[][] = [];
  if (spec.source.kind === "json") {
    const t = await sourceText(spec.source);
    ({ headers, rows } = jsonToTable(JSON.parse(t), spec.source.jsonPath || undefined));
  } else {
    const t = await sourceText(spec.source);
    const grid = parseDelimited(t, spec.source.kind === "tsv" ? "\t" : ",");
    headers = grid[0] ?? [];
    rows = grid.slice(1).map((r) => r.map((v) => (v === "" ? null : parseInput(v).v ?? v)));
  }
  return applySteps({ headers, rows }, spec.steps);
}

export function applySteps(res: QueryResult, steps: QueryStep[]): QueryResult {
  let { headers, rows } = res;
  for (const st of steps) {
    switch (st.op) {
      case "filter": {
        rows = rows.filter((r) => {
          const v = r[st.col];
          const s = v === null || v === undefined ? "" : String(v);
          const cmp = st.value;
          const n = Number(s), nc = Number(cmp);
          const bothNum = s !== "" && cmp !== "" && !isNaN(n) && !isNaN(nc);
          switch (st.cmp) {
            case "=": return bothNum ? n === nc : s.toLowerCase() === cmp.toLowerCase();
            case "!=": return bothNum ? n !== nc : s.toLowerCase() !== cmp.toLowerCase();
            case ">": return bothNum ? n > nc : s > cmp;
            case "<": return bothNum ? n < nc : s < cmp;
            case ">=": return bothNum ? n >= nc : s >= cmp;
            case "<=": return bothNum ? n <= nc : s <= cmp;
            case "contains": return s.toLowerCase().includes(cmp.toLowerCase());
            case "starts": return s.toLowerCase().startsWith(cmp.toLowerCase());
          }
        });
        break;
      }
      case "keepCols": {
        const idx = st.cols.filter((c) => c < headers.length).sort((a, b) => a - b);
        headers = idx.map((c) => headers[c]);
        rows = rows.map((r) => idx.map((c) => r[c] ?? null));
        break;
      }
      case "dropCols": {
        const drop = new Set(st.cols);
        headers = headers.filter((_, i) => !drop.has(i));
        rows = rows.map((r) => r.filter((_, i) => !drop.has(i)));
        break;
      }
      case "rename":
        if (st.col < headers.length) headers = headers.map((h, i) => (i === st.col ? st.name : h));
        break;
      case "sort":
        rows = [...rows].sort((a, b) => {
          const x = a[st.col], y = b[st.col];
          const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
          return cmp * st.dir;
        });
        break;
      case "skip": rows = rows.slice(st.n); break;
      case "take": rows = rows.slice(0, st.n); break;
      case "distinct": {
        const seen = new Set<string>();
        rows = rows.filter((r) => { const k = JSON.stringify(r); return seen.has(k) ? false : (seen.add(k), true); });
        break;
      }
      case "groupBy": {
        const groups = new Map<string, unknown[]>();
        for (const r of rows) {
          const k = String(r[st.col] ?? "");
          (groups.get(k) ?? groups.set(k, []).get(k)!).push(r[st.valCol]);
        }
        const agg = (vals: unknown[]): unknown => {
          const nums = vals.map(Number).filter((n) => !isNaN(n));
          switch (st.agg) {
            case "count": return vals.filter((v) => v !== null && v !== undefined && v !== "").length;
            case "sum": return nums.reduce((a, b) => a + b, 0);
            case "avg": return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
            case "min": return nums.length ? Math.min(...nums) : null;
            case "max": return nums.length ? Math.max(...nums) : null;
          }
        };
        headers = [headers[st.col] ?? "Group", `${st.agg}(${headers[st.valCol] ?? "value"})`];
        rows = [...groups.entries()].map(([k, vals]) => [k, agg(vals)]);
        break;
      }
      case "cast":
        rows = rows.map((r) => r.map((v, i) => {
          if (i !== st.col || v === null || v === undefined || v === "") return v;
          switch (st.to) {
            case "number": { const n = Number(String(v).replace(/[$,]/g, "")); return isNaN(n) ? v : n; }
            case "text": return String(v);
            case "bool": return /^(true|yes|1)$/i.test(String(v));
          }
        }));
        break;
    }
  }
  return { headers, rows };
}

/** Load a query result into a SheetData (headers bolded). */
export function queryToSheet(name: string, res: QueryResult): SheetData {
  const cells: Record<string, CellData> = {};
  res.headers.forEach((h, c) => { cells[toA1(c, 0)] = { v: h, s: { b: true } }; });
  res.rows.forEach((row, r) => row.forEach((v, c) => {
    if (v !== null && v !== undefined && v !== "")
      cells[toA1(c, r + 1)] = typeof v === "string" ? parseInput(v) : { v: v as CellData["v"] };
  }));
  return { name, cells, filter: res.headers.length ? { range: `A1:${toA1(res.headers.length - 1, Math.max(0, res.rows.length))}`, cols: {} } : undefined };
}

/** Run a query and write its result sheet into the workbook (in place —
 *  call inside mutate()). Returns the sheet name written. */
export async function runQueryInto(wb: Workbook, spec: QuerySpec): Promise<string> {
  const res = await runQuery(spec);
  const name = spec.destSheet || spec.name;
  const fresh = queryToSheet(name, res);
  const i = wb.sheets.findIndex((s) => s.name === name);
  if (i >= 0) wb.sheets[i] = fresh; else wb.sheets.push(fresh);
  return name;
}
