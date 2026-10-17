// ---------- S18.2 automation layer — Office Scripts-equivalent ----------
// A script is JS executed against a workbook API surface that mirrors the
// shape of Office Scripts: workbook.getSheet("S").getRange("A1:B2").setValues().
// Scripts run inside mutate() so undo, collab sync, protection stamps and
// autosave apply exactly as for manual edits.

import type { Workbook, SheetData, CellData, CellStyle, Range } from "./model";
import { parseA1, parseRange, toA1, parseInput } from "./model";

export interface ScriptEntry { name: string; code: string; }

export class RangeHandle {
  private sheet: SheetData;
  private range: Range;
  constructor(sheet: SheetData, range: Range) { this.sheet = sheet; this.range = range; }
  getAddress(): string {
    const r = this.range;
    return `${toA1(r.c1, r.r1)}:${toA1(r.c2, r.r2)}`;
  }
  getRowCount(): number { return this.range.r2 - this.range.r1 + 1; }
  getColumnCount(): number { return this.range.c2 - this.range.c1 + 1; }
  getCell(row: number, col: number): RangeHandle {
    const c = this.range.c1 + col, r = this.range.r1 + row;
    if (c > this.range.c2 || r > this.range.r2 || c < this.range.c1 || r < this.range.r1)
      throw new Error(`getCell(${row},${col}) outside ${this.getAddress()}`);
    return new RangeHandle(this.sheet, { c1: c, r1: r, c2: c, r2: r });
  }
  getValues(): unknown[][] {
    const m: unknown[][] = [];
    for (let r = this.range.r1; r <= this.range.r2; r++) {
      const row: unknown[] = [];
      for (let c = this.range.c1; c <= this.range.c2; c++)
        row.push(this.sheet.cells[toA1(c, r)]?.v ?? null);
      m.push(row);
    }
    return m;
  }
  getValue(): unknown { return this.getValues()[0]?.[0] ?? null; }
  setValues(m: unknown[][]): void {
    m.forEach((row, dr) => row.forEach((v, dc) => {
      const r = this.range.r1 + dr, c = this.range.c1 + dc;
      if (r > this.range.r2 || c > this.range.c2) return;
      const p = v === null || v === undefined ? {} : typeof v === "string" ? parseInput(v) : { v: v as CellData["v"] };
      this.sheet.cells[toA1(c, r)] = { ...this.sheet.cells[toA1(c, r)], ...p };
    }));
  }
  setValue(v: unknown): void { this.setValues([[v]]); }
  getFormulas(): string[][] {
    const m: string[][] = [];
    for (let r = this.range.r1; r <= this.range.r2; r++) {
      const row: string[] = [];
      for (let c = this.range.c1; c <= this.range.c2; c++) {
        const f = this.sheet.cells[toA1(c, r)]?.f;
        row.push(f ? `=${f}` : "");
      }
      m.push(row);
    }
    return m;
  }
  setFormulas(m: string[][]): void {
    m.forEach((row, dr) => row.forEach((f, dc) => {
      const r = this.range.r1 + dr, c = this.range.c1 + dc;
      if (r > this.range.r2 || c > this.range.c2) return;
      const ref = toA1(c, r);
      const cell = this.sheet.cells[ref] ?? {};
      const fs = String(f);
      if (fs.startsWith("=")) { cell.f = fs.slice(1); delete cell.v; }
      else { delete cell.f; cell.v = fs === "" ? null : fs; }
      this.sheet.cells[ref] = cell;
    }));
  }
  clear(): void {
    for (let r = this.range.r1; r <= this.range.r2; r++)
      for (let c = this.range.c1; c <= this.range.c2; c++) delete this.sheet.cells[toA1(c, r)];
  }
  setStyle(patch: CellStyle): void {
    for (let r = this.range.r1; r <= this.range.r2; r++)
      for (let c = this.range.c1; c <= this.range.c2; c++) {
        const ref = toA1(c, r);
        this.sheet.cells[ref] = { ...this.sheet.cells[ref], s: { ...this.sheet.cells[ref]?.s, ...patch } };
      }
  }
  setNumberFormat(fmt: string): void { this.setStyle({ fmt }); }
  sort(colOff: number, ascending = true): void {
    const rows = this.getValues();
    const dir = ascending ? 1 : -1;
    rows.sort((a, b) => {
      const x = a[colOff], y = b[colOff];
      const cmp = typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""));
      return cmp * dir;
    });
    this.setValues(rows);
  }
}

export class SheetHandle {
  private wb: Workbook;
  public readonly sheet: SheetData;
  constructor(wb: Workbook, sheet: SheetData) { this.wb = wb; this.sheet = sheet; }
  getName(): string { return this.sheet.name; }
  setName(n: string): void { this.sheet.name = n; }
  getRange(a1: string): RangeHandle {
    const r = parseRange(a1.replace(/\$/g, ""));
    if (!r) throw new Error(`Bad range "${a1}"`);
    return new RangeHandle(this.sheet, r);
  }
  getCell(row: number, col: number): RangeHandle {
    return new RangeHandle(this.sheet, { c1: col, r1: row, c2: col, r2: row });
  }
  getUsedRange(): RangeHandle | null {
    const refs = Object.keys(this.sheet.cells);
    if (!refs.length) return null;
    let c1 = Infinity, r1 = Infinity, c2 = -1, r2 = -1;
    for (const ref of refs) {
      const p = parseA1(ref)!;
      c1 = Math.min(c1, p.col); r1 = Math.min(r1, p.row);
      c2 = Math.max(c2, p.col); r2 = Math.max(r2, p.row);
    }
    return new RangeHandle(this.sheet, { c1, r1, c2, r2 });
  }
  delete(): void {
    const i = this.wb.sheets.indexOf(this.sheet);
    if (i >= 0) this.wb.sheets.splice(i, 1);
  }
}

export class WorkbookApi {
  private wb: Workbook;
  private active: string;
  constructor(wb: Workbook, active: string) { this.wb = wb; this.active = active; }
  getActiveSheet(): SheetHandle { return this.getSheet(this.active) ?? new SheetHandle(this.wb, this.wb.sheets[0]); }
  getSheet(name: string): SheetHandle | null {
    const s = this.wb.sheets.find((x) => x.name === name);
    return s ? new SheetHandle(this.wb, s) : null;
  }
  getSheets(): SheetHandle[] { return this.wb.sheets.map((s) => new SheetHandle(this.wb, s)); }
  addSheet(name?: string): SheetHandle {
    const s: SheetData = { name: name ?? `Sheet${this.wb.sheets.length + 1}`, cells: {} };
    this.wb.sheets.push(s);
    return new SheetHandle(this.wb, s);
  }
  getNamedItem(name: string): RangeHandle | null {
    const ref = this.wb.names?.[name];
    if (!ref) return null;
    const [sn, rng] = ref.includes("!") ? ref.split("!") : [this.active, ref];
    return this.getSheet(sn)?.getRange(rng) ?? null;
  }
  addNamedItem(name: string, ref: string): void { (this.wb.names ??= {})[name] = ref; }
}

/** Run `code` against `wb`, mutating in place. Returns the console.log output
 *  lines. Throws on script errors — callers should toast/report them.
 *  Only invoked inside the sandboxed iframe: the app CSP forbids eval. */
export function runScript(wb: Workbook, code: string, activeSheetName = ""): string[] {
  const log: string[] = [];
  const api = new WorkbookApi(wb, activeSheetName);
  const fakeConsole = { log: (...a: unknown[]) => log.push(a.map((x) => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" ")) };
  const fn = new Function("workbook", "console", `"use strict";\n${code}`) as (w: WorkbookApi, c: typeof fakeConsole) => void;
  fn(api, fakeConsole);
  return log;
}

// ---------- sandboxed execution ----------
// new Function() is blocked by the app's CSP (no 'unsafe-eval'), so scripts
// execute inside a sandboxed iframe served at /script-sandbox.html — an
// opaque-origin page whose own (relaxed) CSP permits eval. Confinement is
// real: the frame can't reach app DOM, cookies, storage, or make same-origin
// fetches; the only bridge is postMessage — workbook in, mutated sheets/names
// out. The main document CSP stays strict.

export interface SandboxOutcome {
  sheets: SheetData[];
  names: Record<string, string> | null;
  log: string[];
}

let frame: HTMLIFrameElement | null = null;
let frameReady: Promise<HTMLIFrameElement> | null = null;
let seq = 0;
const inflight = new Map<string, {
  resolve: (o: SandboxOutcome) => void; reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();

function onSandboxMessage(ev: MessageEvent) {
  if (ev.source !== frame?.contentWindow) return;
  const d = ev.data as { id?: string; ok?: boolean; sheets?: SheetData[]; names?: Record<string, string>; log?: string[]; error?: string };
  const p = typeof d?.id === "string" ? inflight.get(d.id) : undefined;
  if (!p) return;
  inflight.delete(d.id!);
  clearTimeout(p.timer);
  if (d.ok) p.resolve({ sheets: d.sheets ?? [], names: d.names ?? null, log: d.log ?? [] });
  else p.reject(new Error(d.error ?? "Script failed"));
}

function ensureFrame(): Promise<HTMLIFrameElement> {
  frameReady ??= new Promise((resolve, reject) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.src = "/script-sandbox.html";
    f.style.display = "none";
    f.addEventListener("load", () => { frame = f; resolve(f); });
    f.addEventListener("error", () => { frameReady = null; reject(new Error("Script sandbox failed to load")); });
    window.addEventListener("message", onSandboxMessage);
    document.body.appendChild(f);
  });
  return frameReady;
}

/** Run `code` against a clone of `wb` inside the sandboxed iframe. Resolves
 *  with the mutated sheets/names — callers apply them inside mutate(). */
export async function runScriptSandboxed(wb: Workbook, code: string, activeSheetName = ""): Promise<SandboxOutcome> {
  const f = await ensureFrame();
  const id = `s${++seq}`;
  return new Promise<SandboxOutcome>((resolve, reject) => {
    const timer = setTimeout(() => {
      inflight.delete(id);
      // a runaway script shares the main thread and can't be interrupted —
      // drop the frame so at least the next run gets a fresh sandbox
      frame?.remove();
      frame = null;
      frameReady = null;
      reject(new Error("Script timed out"));
    }, 15_000);
    inflight.set(id, { resolve, reject, timer });
    f.contentWindow?.postMessage(
      { id, code, workbook: structuredClone(wb), active: activeSheetName },
      { targetOrigin: "*" });
  });
}
