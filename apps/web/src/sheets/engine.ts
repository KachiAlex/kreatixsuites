import { Parser } from "hot-formula-parser";
import type { CellData } from "./model";
import { toA1 } from "./model";

export interface EvalResult {
  value: unknown;
  error: string | null;
}

const MAX_DEPTH = 64;

/**
 * Evaluate every formula cell in a sheet with memoization + cycle detection
 * (KBS-SHEETS-002 formula engine; full-sheet recalc is fine at MVP scale).
 */
export function evaluateSheet(cells: Record<string, CellData>): Map<string, EvalResult> {
  const cache = new Map<string, EvalResult>();
  const visiting = new Set<string>();

  function evalCell(ref: string, depth: number): EvalResult {
    const cached = cache.get(ref);
    if (cached) return cached;
    const cell = cells[ref];
    let out: EvalResult;
    if (!cell) out = { value: null, error: null };
    else if (!cell.f) out = { value: cell.v ?? null, error: null };
    else if (visiting.has(ref) || depth > MAX_DEPTH) out = { value: null, error: "#CYCLE!" };
    else {
      visiting.add(ref);
      out = runFormula(cell.f, depth);
      visiting.delete(ref);
    }
    cache.set(ref, out);
    return out;
  }

  function runFormula(formula: string, depth: number): EvalResult {
    const parser = new Parser();
    parser.on("callCellValue", (coord, done) => {
      const ref = toA1(coord.column.index, coord.row.index);
      const r = evalCell(ref, depth + 1);
      done(r.error ?? r.value ?? null);
    });
    parser.on("callRangeValue", (start, end, done) => {
      const matrix: unknown[][] = [];
      for (let r = start.row.index; r <= end.row.index; r++) {
        const row: unknown[] = [];
        for (let c = start.column.index; c <= end.column.index; c++) {
          const res = evalCell(toA1(c, r), depth + 1);
          row.push(res.error ?? res.value ?? null);
        }
        matrix.push(row);
      }
      done(matrix);
    });
    try {
      const { error, result } = parser.parse(formula);
      return error ? { value: null, error } : { value: result ?? null, error: null };
    } catch {
      return { value: null, error: "#ERROR!" };
    }
  }

  for (const ref of Object.keys(cells)) evalCell(ref, 0);
  return cache;
}

export function displayValue(res: EvalResult | undefined, cell: CellData | undefined): string {
  if (!cell) return "";
  if (res?.error) return res.error;
  const v = cell.f ? res?.value : (res?.value ?? cell.v);
  if (v === null || v === undefined) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}
