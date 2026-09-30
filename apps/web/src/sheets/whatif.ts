// Kreatix Sheets — what-if analysis beyond Goal Seek (S19.6):
//   Scenario Manager  — named cell snapshots applied on demand
//   Data Tables       — 1- and 2-variable sensitivity grids
//   Solver            — linear programming via two-phase simplex with a
//                       small branch-and-bound pass for integer variables

import type { CellData, Scenario, Workbook } from "./model";
import { parseA1, toA1 } from "./model";
import { evaluateWorkbook } from "./engine";
import { solveGoalSeek } from "./io";

const cloneWb = (wb: Workbook): Workbook =>
  typeof structuredClone === "function" ? structuredClone(wb) : JSON.parse(JSON.stringify(wb));

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Evaluate `ref` in `sheetName` with `patch` applied to input cells —
 *  patch maps A1 refs to substitute values (null restores the original). */
function evalWith(wb: Workbook, sheetName: string, patch: Record<string, CellData["v"]>, ref: string): number | null {
  const tmp = cloneWb(wb);
  const sh = tmp.sheets.find((s) => s.name === sheetName);
  if (!sh) return null;
  for (const [r, v] of Object.entries(patch)) {
    const cur = sh.cells[r] ?? {};
    sh.cells[r] = { ...cur, v, f: undefined };
  }
  const res = evaluateWorkbook(tmp).get(sheetName)?.get(ref);
  return res?.error ? null : num(res?.value);
}

// ---------- Scenario Manager ----------

/** Snapshot the current values of `refs` for a new scenario. */
export function captureScenario(wb: Workbook, sheetName: string, name: string, refs: string[]): Scenario {
  const sheet = wb.sheets.find((s) => s.name === sheetName);
  const cells: Scenario["cells"] = {};
  for (const ref of refs) {
    const c = sheet?.cells[ref];
    cells[ref] = c?.v ?? null;
  }
  return { name, cells };
}

// ---------- Data Tables ----------

export interface DataTableSpec {
  /** cell holding the result formula (the corner of the table) */
  formulaRef: string;
  /** input cell varied down the table's first column */
  input1: string;
  values1: (number | string)[];
  /** optional second input cell varied across the top row (two-var table) */
  input2?: string;
  values2?: (number | string)[];
}

/** Compute the result matrix for a one- or two-variable data table.
 *  One-var → column of results; two-var → (values2+1)×(values1+1) matrix
 *  with the corner cell holding the formula's base value. */
export function runDataTable(
  wb: Workbook, sheetName: string, spec: DataTableSpec,
): { matrix: (number | string | null)[][]; error?: string } {
  const MAX_CELLS = 900;
  const v2 = spec.values2 ?? [];
  if (spec.values1.length * (v2.length || 1) > MAX_CELLS)
    return { matrix: [], error: `Data table limited to ${MAX_CELLS} computed cells` };
  const evalFormula = (patch: Record<string, CellData["v"]>) =>
    evalWith(wb, sheetName, patch, spec.formulaRef);
  if (!spec.input2) {
    const col = spec.values1.map((x) => evalFormula({ [spec.input1]: x }));
    return { matrix: col.map((v) => [v]) };
  }
  const rows: (number | string | null)[][] = [];
  // first row: header row = values2 (corner handled by caller)
  rows.push([null, ...v2.map((v) => v)]);
  for (const a of spec.values1) {
    const row: (number | string | null)[] = [a];
    for (const b of v2) row.push(evalFormula({ [spec.input1]: a, [spec.input2!]: b }));
    rows.push(row);
  }
  return { matrix: rows };
}

// ---------- Solver (linear model via numeric coefficients + simplex) ----------

export interface SolverConstraint { lhs: string; op: "<=" | ">=" | "="; rhs: number }
export interface SolverSpec {
  targetRef: string;
  sense: "max" | "min" | "value";
  targetValue?: number;
  changing: string[];
  constraints: SolverConstraint[];
  /** changing refs that must take integer values */
  integers?: string[];
  nonNeg?: boolean; // default true, like Excel's "Assume Non-Negative"
}

export interface SolverResult {
  ok: boolean;
  message: string;
  /** values to write into the changing cells */
  values?: Record<string, number>;
  objective?: number;
  /** true when the model was LP and an exact optimum was certified */
  exact?: boolean;
}

/** Extract linear coefficients for an expression cell by perturbation:
 *  expr(x) ≈ a·x + b — coefficients are (expr(e_i) − expr(0)). If the model
 *  is nonlinear this silently approximates, so callers report `exact`. */
function linearCoeffs(
  wb: Workbook, sheetName: string, changing: string[], ref: string,
): { a: number[]; b: number; linear: boolean } {
  const at = (xs: number[]) => {
    const patch: Record<string, CellData["v"]> = {};
    changing.forEach((r, i) => { patch[r] = xs[i]; });
    return evalWith(wb, sheetName, patch, ref) ?? 0;
  };
  const zero = changing.map(() => 0);
  const b = at(zero);
  const a = changing.map((_, i) => at(zero.map((z, j) => (j === i ? 1 : z))) - b);
  // linearity probe: expr(2e_i) should equal b + 2a_i within tolerance
  let linear = true;
  for (let i = 0; i < changing.length && linear; i++) {
    const probe = at(zero.map((z, j) => (j === i ? 2 : z)));
    if (Math.abs(probe - (b + 2 * a[i])) > 1e-6 * (1 + Math.abs(b))) linear = false;
  }
  return { a, b, linear };
}

/** Two-phase simplex. Maximizes c·x s.t. rows of A (with ops) ≤/≥/= b,
 *  x ≥ 0. Returns x or null when infeasible/unbounded. */
function simplex(c: number[], A: number[][], ops: ("<=" | ">=" | "=")[], b: number[]): number[] | null {
  const n = c.length, m = A.length;
  if (m === 0) {
    // unconstrained: finite only when all c ≤ 0 (max at origin)
    return c.every((x) => x <= 1e-9) ? c.map(() => 0) : null;
  }
  // normalize: flip ≥ constraints to ≤ by negation; keep = rows
  type Row = { a: number[]; op: "<=" | "="; b: number };
  const rows: Row[] = A.map((a, i) =>
    ops[i] === ">=" ? { a: a.map((x) => -x), op: "<=", b: -b[i] } : { a: [...a], op: ops[i], b: b[i] });
  // a ≤ row with negative b still needs an artificial (slack would start
  // infeasible) — count those too so the tableau has room for them
  const needArt = rows.map((r) => r.op === "=" || r.b < -1e-9);
  const slackCols = rows.filter((r) => r.op === "<=").length;
  const artCols = needArt.filter(Boolean).length;
  const width = n + slackCols + artCols + 1;
  const basis: number[] = new Array(m).fill(-1);
  const T: number[][] = rows.map(() => new Array(width).fill(0));
  let sc = n, ac = n + slackCols;
  rows.forEach((r, i) => {
    r.a.forEach((v, j) => { T[i][j] = v; });
    if (r.op === "<=") T[i][sc++] = 1;
    if (needArt[i]) { T[i][ac++] = 1; basis[i] = ac - 1; }
    else basis[i] = sc - 1;
    T[i][width - 1] = r.b;
  });
  const isArt = (j: number) => j >= n + slackCols;
  const pivot = (r: number, col: number) => {
    const p = T[r][col];
    for (let j = 0; j < width; j++) T[r][j] /= p;
    for (let i = 0; i <= m; i++) {
      if (i === r) continue;
      const f = T[i]?.[col];
      if (!f) continue;
      for (let j = 0; j < width; j++) T[i][j] -= f * T[r][j];
    }
    basis[r] = col;
  };
  const solve = (cost: number[]) => {
    T[m] = new Array(width).fill(0);
    for (let j = 0; j < width - 1; j++) T[m][j] = -cost[j];
    // reduce: add cost-weighted basic rows so reduced costs are right
    for (let i = 0; i < m; i++) {
      const bj = basis[i];
      if (bj < 0) continue;
      const cb = cost[bj] ?? 0;
      if (!cb) continue;
      for (let j = 0; j < width; j++) T[m][j] += cb * T[i][j];
    }
    for (let it = 0; it < 2000; it++) {
      let col = -1, best = -1e-9;
      for (let j = 0; j < width - 1; j++) if (T[m][j] < best) { best = T[m][j]; col = j; }
      if (col < 0) return true; // optimal
      let row = -1, ratio = Infinity;
      for (let i = 0; i < m; i++) {
        if (T[i][col] > 1e-9) {
          const rt = T[i][width - 1] / T[i][col];
          if (rt < ratio - 1e-9) { ratio = rt; row = i; }
        }
      }
      if (row < 0) return false; // unbounded
      pivot(row, col);
    }
    return false;
  };
  // phase 1: feasibility when artificials present
  if (artCols > 0 || basis.some((b2) => isArt(b2))) {
    const cost = new Array(width - 1).fill(0);
    for (let j = n + slackCols; j < width - 1; j++) cost[j] = 1;
    if (!solve(cost) || Math.abs(T[m][width - 1]) > 1e-7) return null;
  }
  // phase 2: real objective
  const cost = new Array(width - 1).fill(0);
  c.forEach((v, j) => { cost[j] = v; });
  if (!solve(cost)) return null;
  const x = new Array(n).fill(0);
  for (let i = 0; i < m; i++) if (basis[i] >= 0 && basis[i] < n) x[basis[i]] = T[i][width - 1];
  return x;
}

/** Small depth-first branch & bound over integer variables using LP
 *  relaxations — fine for typical Solver models (≤ ~10 integer vars). */
function branchAndBound(
  c: number[], A: number[][], ops: ("<=" | ">=" | "=")[], b: number[],
  intIdx: number[], maximize: boolean, nonNeg: boolean,
): { x: number[]; obj: number } | null {
  interface Node { A: number[][]; ops: ("<=" | ">=" | "=")[]; b: number[] }
  const better = (a: number, z: number) => (maximize ? a > z : a < z);
  let incumbent: { x: number[]; obj: number } | null = null;
  const stack: Node[] = [{ A, ops, b }];
  let nodes = 0;
  const obj = (x: number[]) => c.reduce((s, v, i) => s + v * x[i], 0);
  const feasible = (x: number[], A2: number[][], ops2: ("<=" | ">=" | "=")[], b2: number[]) =>
    A2.every((row, i) => {
      const lhs = row.reduce((s, v, j) => s + v * x[j], 0);
      return ops2[i] === "<=" ? lhs <= b2[i] + 1e-6 : ops2[i] === ">=" ? lhs >= b2[i] - 1e-6 : Math.abs(lhs - b2[i]) < 1e-5;
    }) && (nonNeg ? x.every((v) => v >= -1e-7) : true);
  while (stack.length && nodes++ < 400) {
    const node = stack.pop()!;
    const x = simplex(c, node.A, node.ops, node.b);
    if (!x) continue;
    const o = obj(x);
    if (incumbent && !better(o - 1e-9, incumbent.obj)) continue;
    const frac = intIdx.find((i) => Math.abs(x[i] - Math.round(x[i])) > 1e-6);
    if (frac === undefined) {
      if (feasible(x, node.A, node.ops, node.b) && (!incumbent || better(o, incumbent.obj)))
        incumbent = { x, obj: o };
      continue;
    }
    const lo = Math.floor(x[frac]), hi = Math.ceil(x[frac]);
    for (const bd of [lo, hi]) {
      const row = new Array(c.length).fill(0);
      row[frac] = 1;
      stack.push({ A: [...node.A, row], ops: [...node.ops, "="], b: [...node.b, bd] });
    }
    // also branch ≤lo / ≥hi to keep the tree honest
    if (Math.abs(hi - lo) > 0) {
      const rowL = new Array(c.length).fill(0); rowL[frac] = 1;
      stack.push({ A: [...node.A, rowL], ops: [...node.ops, "<="], b: [...node.b, lo] });
      const rowH = new Array(c.length).fill(0); rowH[frac] = 1;
      stack.push({ A: [...node.A, rowH], ops: [...node.ops, ">="], b: [...node.b, hi] });
    }
  }
  return incumbent;
}

/** Solve a SolverSpec against the workbook. */
export function runSolver(wb: Workbook, sheetName: string, spec: SolverSpec): SolverResult {
  const sheet = wb.sheets.find((s) => s.name === sheetName);
  if (!sheet) return { ok: false, message: "Sheet not found" };
  const changing = spec.changing.filter((r) => parseA1(r));
  if (!changing.length) return { ok: false, message: "Add at least one changing cell" };
  if (!parseA1(spec.targetRef)) return { ok: false, message: "Set-objective cell is invalid" };

  // "value of" mode with a single changing cell → goal-seek with the
  // existing robust solver (constraints aren't honored in this mode)
  if (spec.sense === "value") {
    const goal = spec.targetValue ?? 0;
    const start = num(sheet.cells[changing[0]]?.v) ?? 0;
    const x = solveGoalSeek(
      (v) => evalWith(wb, sheetName, { [changing[0]]: v }, spec.targetRef),
      goal, start,
    );
    return x === null
      ? { ok: false, message: "Solver could not reach the target value" }
      : { ok: true, exact: true, message: "Solver found a solution",
          values: { [changing[0]]: x }, objective: goal };
  }

  // LP extraction — objective coefficients
  const obj = linearCoeffs(wb, sheetName, changing, spec.targetRef);
  const cons = spec.constraints.filter((cn) => parseA1(cn.lhs) && Number.isFinite(cn.rhs));
  const A: number[][] = [], ops: ("<=" | ">=" | "=")[] = [], b: number[] = [];
  let allLinear = obj.linear;
  for (const cn of cons) {
    const lc = linearCoeffs(wb, sheetName, changing, cn.lhs);
    if (!lc.linear) allLinear = false;
    A.push(lc.a);
    ops.push(cn.op);
    b.push(cn.rhs - lc.b); // a·x ≤ rhs − intercept
  }
  const nonNeg = spec.nonNeg !== false;
  const c = spec.sense === "max" ? obj.a : obj.a.map((v) => -v);
  const intIdx = (spec.integers ?? []).map((r) => changing.indexOf(r)).filter((i) => i >= 0);
  let x: number[] | null;
  let exact = allLinear;
  if (intIdx.length) {
    const bb = branchAndBound(c, A, ops, b, intIdx, true, nonNeg);
    x = bb?.x ?? null;
    if (!bb) exact = false;
  } else {
    x = simplex(c, A, ops, b);
    if (x === null) {
      // could be infeasible OR unbounded — distinguish via a bounded probe
      return { ok: false, message: "Solver: model is infeasible or unbounded (check constraints / bounds)" };
    }
  }
  if (!x) return { ok: false, message: "Solver found no feasible integer solution" };
  const values: Record<string, number> = {};
  changing.forEach((r, i) => {
    values[r] = intIdx.includes(i) ? Math.round(x[i]) : Number(x[i].toPrecision(10));
  });
  const objective = evalWith(wb, sheetName, values, spec.targetRef);
  return {
    ok: true,
    exact,
    message: exact
      ? "Solver found an optimal solution"
      : "Solver found a solution (model is not purely linear — verify results)",
    values,
    objective: objective ?? undefined,
  };
}

/** Convenience: list every A1 ref in a CSV-ish string the user typed. */
export function parseRefList(s: string): string[] {
  return s.split(/[,\s;]+/).map((x) => x.trim().toUpperCase()).filter((x) => !!parseA1(x));
}

/** Expand "B2:B10"-style ranges into their member refs. */
export function refsInRangeText(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[,\s;]+/).filter(Boolean)) {
    const m = part.trim().toUpperCase();
    const r = m.includes(":")
      ? (() => { const [a, b] = m.split(":"); const pa = parseA1(a), pb = parseA1(b);
          if (!pa || !pb) return null;
          return { c1: Math.min(pa.col, pb.col), r1: Math.min(pa.row, pb.row), c2: Math.max(pa.col, pb.col), r2: Math.max(pa.row, pb.row) }; })()
      : (() => { const p = parseA1(m); return p ? { c1: p.col, r1: p.row, c2: p.col, r2: p.row } : null; })();
    if (!r) continue;
    for (let row = r.r1; row <= r.r2; row++) for (let col = r.c1; col <= r.c2; col++) out.push(toA1(col, row));
  }
  return out;
}
