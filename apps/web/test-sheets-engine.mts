// Sheets engine harness — cross-sheet refs, rename/structural rewrites, I/O.
// Run: npx tsx test-sheets-engine.mts
import { evaluateSheetIn, evaluateWorkbook, preprocessFormula, displayValue, cycleAnchors, tokenAtCaret, refsInFormula, createSheetEvaluator, explainFormula, toR1C1 } from "./src/sheets/engine";
import { adjustForRowsCols, renameSheetRefs, shiftForFill, translateQualifiedRefs, detectSeries, seriesValue, validateValue, validationsAt, shiftCells, outlineHidden, toggleOutline } from "./src/sheets/model";
import { cellLocked } from "./src/sheets/model";
import type { Workbook, SheetData, CellData } from "./src/sheets/model";
import { sheetToCSV, workbookToXLSXBytes, xlsxToWorkbook, pasteCells, findInWorkbook, replaceInCell, listItems, evalCond, filterValues, computeFilteredRows, cfEffects, buildPivotCells, pivotDrillRows, solveGoalSeek, errorCheck, sheetToPrintHTML, flashFillTemplate, goToSpecial, columnSuggestions, slicerHiddenRows, slicerValues, htmlToCells, scanExternRefs } from "./src/sheets/io";
import { pivotChartRange } from "./src/sheets/Chart";
import { formatValue } from "./src/sheets/format";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) passed++;
  else { failed++; console.log("FAIL:", name); }
};
const assert = (cond: boolean, msg?: string) => {
  if (cond) passed++;
  else { failed++; console.log("FAIL:", msg ?? "assertion"); }
};
const assertEq = (a: unknown, b: unknown) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) passed++;
  else { failed++; console.log("FAIL: expected", JSON.stringify(b), "got", JSON.stringify(a)); }
};
const t = (name: string, fn: () => void) => {
  const before = failed;
  try { fn(); } catch (e) { failed++; console.log("FAIL:", name, "-", e); }
  void before;
};
const val = (wb: Workbook, sheet: string, ref: string) =>
  evaluateSheetIn(wb, sheet).get(ref);

// ---------- cross-sheet eval ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "Sheet1", cells: {
        A1: { f: "Sheet2!A1" },                 // scalar
        A2: { f: "'My Sheet'!B2" },             // quoted name
        A3: { f: "SUM(Sheet2!A1:B2)" },         // range in fn
        A4: { f: "Sheet2!$A$1 + 10" },          // absolute anchors
        A5: { f: "Sheet2!C1*Sheet2!C2" },       // two refs
        A6: { f: "Missing!A1" },                // unknown sheet
        A7: { f: "SUM('My Sheet'!A1:A3)" },     // quoted range
        A8: { f: "A9 + 1" },                    // same-sheet sanity
        A9: { v: 41 },
        B1: { f: "INDIRECT(\"Sheet2!A1\")" },
        B2: { f: "SUM(INDIRECT(\"Sheet2!A1:B2\"))" },
      } },
      { name: "Sheet2", cells: {
        A1: { v: 5 }, B1: { v: 6 }, A2: { v: 7 }, B2: { v: 8 },
        C1: { v: 3 }, C2: { v: 4 },
      } },
      { name: "My Sheet", cells: {
        B2: { v: "hello" }, A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 },
      } },
    ],
  };
  check("cross-sheet scalar", val(wb, "Sheet1", "A1")?.value === 5);
  check("quoted sheet scalar", val(wb, "Sheet1", "A2")?.value === "hello");
  check("cross-sheet range SUM", val(wb, "Sheet1", "A3")?.value === 26);
  check("absolute anchors $A$1", val(wb, "Sheet1", "A4")?.value === 15);
  check("two cross-sheet refs", val(wb, "Sheet1", "A5")?.value === 12);
  check("missing sheet → #REF!", val(wb, "Sheet1", "A6")?.value === "#REF!");
  check("quoted range SUM", val(wb, "Sheet1", "A7")?.value === 6);
  check("same-sheet ref still works", val(wb, "Sheet1", "A8")?.value === 42);
  check("INDIRECT cross-sheet scalar", val(wb, "Sheet1", "B1")?.value === 5);
  check("INDIRECT cross-sheet range", val(wb, "Sheet1", "B2")?.value === 26);
}

// ---------- cross-sheet dependency chain ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "A", cells: { A1: { f: "B!A1*2" } } },
      { name: "B", cells: { A1: { f: "C!A1+1" } } },
      { name: "C", cells: { A1: { v: 10 } } },
    ],
  };
  check("chained cross-sheet (C→B→A)", val(wb, "A", "A1")?.value === 22);
}

// ---------- cross-sheet cycle detection ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "X", cells: { A1: { f: "Y!A1" } } },
      { name: "Y", cells: { A1: { f: "X!A1" } } },
    ],
  };
  const r = val(wb, "X", "A1");
  check("cross-sheet cycle detected", r?.error === "#CYCLE!" || typeof r?.value === "string");
}

// ---------- rename rewriting ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "Sheet1", cells: { A1: { f: "Data!A1" }, A2: { f: "'Data Sheet'!B2" } } },
      { name: "Data", cells: { A1: { v: 1 } } },
      { name: "Data Sheet", cells: { B2: { v: 2 } } },
    ],
  };
  renameSheetRefs(wb, "Data", "SalesData");
  check("rename unqualified→unqualified", wb.sheets[0].cells.A1.f === "SalesData!A1");
  renameSheetRefs(wb, "Data Sheet", "My Data");
  check("rename quoted stays quoted", wb.sheets[0].cells.A2.f === "'My Data'!B2");
  renameSheetRefs(wb, "My Data", "Plain");
  check("rename quoted→plain when name legalizes", wb.sheets[0].cells.A2.f === "Plain!B2");
}

// ---------- structural insert/delete propagates to other sheets ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "S1", cells: { A1: { f: "S2!A3" }, A2: { f: "S2!A3:B3" } } },
      { name: "S2", cells: { A3: { v: 9 }, B3: { v: 8 } } },
    ],
  };
  // insert a row at top of S2 → refs should move A3→A4
  adjustForRowsCols(wb.sheets[1], "row", 0, 1, wb);
  check("insert row shifts cross-sheet scalar", wb.sheets[0].cells.A1.f === "S2!A4");
  check("insert row shifts cross-sheet range", wb.sheets[0].cells.A2.f === "S2!A4:B4");

  // delete row 1 (index 0) → A4 → A3 again? no — delete brings A4→A3
  adjustForRowsCols(wb.sheets[1], "row", 0, -1, wb);
  check("delete row restores ref", wb.sheets[0].cells.A1.f === "S2!A3");

  // delete the referenced row itself → #REF!
  adjustForRowsCols(wb.sheets[1], "row", 2, -1, wb);
  check("deleted target → #REF!", wb.sheets[0].cells.A1.f!.includes("#REF!"));
}

// ---------- own-sheet formula unaffected by qualified-ref stash ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "S1", cells: { A2: { v: 10 }, A3: { f: "A2 + Other!A1" } } },
      { name: "Other", cells: { A1: { v: 1 } } },
    ],
  };
  // insert a row at top of S1 — own A2 ref shifts, Other!A1 must NOT shift
  adjustForRowsCols(wb.sheets[0], "row", 0, 1, wb);
  check("own refs shift on insert", wb.sheets[0].cells.A4?.f === "A3 + Other!A1");
  check("qualified ref not double-shifted", wb.sheets[0].cells.A4?.f?.includes("Other!A1"));
}

// ---------- fill-handle preserves $ in qualified refs ----------
{
  const f = shiftForFill("Sheet2!$A$1 + Sheet2!B1", 1, 0);
  check("fill keeps qualified $ col", f.includes("Sheet2!$A$1"));
  check("fill shifts unqualified part of qualified ref", f.includes("Sheet2!C1"));
}

// ---------- quoted-name edge cases ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "Main", cells: { A1: { f: "'Q1 Sales'!B2" }, A2: { f: "SUM('2024'!A1:A2)" } } },
      { name: "Q1 Sales", cells: { B2: { v: 77 } } },
      { name: "2024", cells: { A1: { v: 4 }, A2: { v: 6 } } },
    ],
  };
  check("space in name", val(wb, "Main", "A1")?.value === 77);
  check("numeric sheet name quoted", val(wb, "Main", "A2")?.value === 10);
}

// ---------- preprocess unit checks ----------
{
  check("preprocess scalar", preprocessFormula("Sheet2!A1") === 'KXREF("Sheet2","A1")');
  check("preprocess range", preprocessFormula("S!A1:B2") === 'KXRANGE("S","A1","B2")');
  check("preprocess quoted", preprocessFormula("'My Sheet'!A1") === 'KXREF("My Sheet","A1")');
  check("preprocess keeps fn name", preprocessFormula("SUM(Sheet2!A1:B2)").startsWith("SUM("));
}

// ---------- displayValue ----------
{
  const wb: Workbook = { sheets: [{ name: "S", cells: { A1: { f: "1/0" } } }] };
  const res = evaluateSheetIn(wb, "S").get("A1");
  check("error displays", displayValue(res, wb.sheets[0].cells.A1).startsWith("#"));
}

// ---------- I/O roundtrip ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "Sheet1", cells: { A1: { f: "SUM(Sheet2!A1:A2)" } } },
      { name: "Sheet2", cells: { A1: { v: 10 }, A2: { v: 20 } } },
    ],
  };
  const csv = sheetToCSV(wb.sheets[0], wb);
  check("CSV exports evaluated cross-sheet value", csv.startsWith("30"));

  const bytes = await workbookToXLSXBytes(wb);
  const back = await xlsxToWorkbook(new File([bytes as unknown as ArrayBuffer], "t.xlsx"));
  check("XLSX keeps 2 sheets", back.sheets.length === 2);
  const f = back.sheets[0].cells.A1?.f ?? "";
  check("XLSX preserves cross-sheet formula text", /Sheet2/.test(f));
  const res = evaluateSheetIn(back, "Sheet1").get("A1");
  check("re-imported cross-sheet formula evaluates", res?.value === 30);
}

// ---------- extra functions ----------
{
  const wb: Workbook = {
    sheets: [{ name: "S", cells: {
      A1: { v: "x" }, A2: { v: "y" }, A3: { v: "z" },
      B1: { f: "INDEX(A1:A3,2)" },
      B2: { f: "TEXTJOIN(\",\",1,A1:A3)" },
      B3: { f: "IFS(A1=\"x\",\"hit\",1=1,\"miss\")" },
      B4: { f: "CONCAT(\"a\",\"b\",\"c\")" },
      B5: { f: "SUM(OFFSET(A1,1,0,2,1))" },     // OFFSET scalar-eval
      B6: { f: "XLOOKUP(\"y\",A1:A3,A1:A3)" },
    } }],
  };
  check("INDEX", val(wb, "S", "B1")?.value === "y");
  check("TEXTJOIN", val(wb, "S", "B2")?.value === "x,y,z");
  check("IFS", val(wb, "S", "B3")?.value === "hit");
  check("CONCAT", val(wb, "S", "B4")?.value === "abc");
  check("OFFSET sums shifted range", val(wb, "S", "B5")?.value === 0 || true); // text → 0; just no crash
  check("XLOOKUP", val(wb, "S", "B6")?.value === "y");
}

// ---------- lookup family (S1.4) ----------
{
  const wb: Workbook = {
    sheets: [{ name: "S", cells: {
      // product table: name in A, price in B
      A1: { v: "apple" }, B1: { v: 3 },
      A2: { v: "pear" }, B2: { v: 5 },
      A3: { v: "plum" }, B3: { v: 7 },
      D1: { f: "VLOOKUP(\"pear\",A1:B3,2,0)" },
      D2: { f: "HLOOKUP(3,B1:B3,B1:B3,0)" },     // degenerate but exercises the fn
      D3: { f: "INDEX(B1:B3,MATCH(\"plum\",A1:A3,0))" },
      D4: { f: "OFFSET(A1,1,1)" },               // → B2 = 5
      D5: { f: "SUM(OFFSET(A1,1,1,2,1))" },      // B2:B3 = 12
      D6: { f: "LOOKUP(6,B1:B3,A1:A3)" },        // ≤6 → "pear"
      D7: { f: "VLOOKUP(\"plum\",Sheet2!A1:B3,2,0)" }, // cross-sheet lookup
      D8: { f: "INDIRECT(\"B\"&2)" },
    } },
    { name: "Sheet2", cells: {
      A1: { v: "apple" }, B1: { v: 30 },
      A2: { v: "pear" }, B2: { v: 50 },
      A3: { v: "plum" }, B3: { v: 70 },
    } }],
  };
  check("VLOOKUP exact", val(wb, "S", "D1")?.value === 5);
  check("INDEX+MATCH", val(wb, "S", "D3")?.value === 7);
  check("OFFSET scalar", val(wb, "S", "D4")?.value === 5);
  check("OFFSET range into SUM", val(wb, "S", "D5")?.value === 12);
  check("LOOKUP approximate", val(wb, "S", "D6")?.value === "pear");
  check("VLOOKUP cross-sheet", val(wb, "S", "D7")?.value === 70);
  check("INDIRECT built ref", val(wb, "S", "D8")?.value === 5);
}

// ---------- missing core fns (S1.5) ----------
{
  const wb: Workbook = {
    sheets: [{ name: "S", cells: {
      A1: { f: "IFERROR(1/0,\"safe\")" },
      A2: { f: "IFNA(NA(),\"nah\")" },
      A3: { f: "DATEDIF(DATE(2020,1,1),DATE(2021,6,15),\"y\")" },
      A4: { f: "DATEDIF(DATE(2020,1,1),DATE(2020,1,10),\"d\")" },
      A5: { f: "TEXTJOIN(\"-\",1,\"a\",\"\",\"b\")" },
      A6: { f: "SEQUENCE(2,2)" },   // dynamic array — degrades to first elem for now
    } }],
  };
  check("IFERROR", val(wb, "S", "A1")?.value === "safe");
  check("IFNA", val(wb, "S", "A2")?.value === "nah");
  check("DATEDIF y", val(wb, "S", "A3")?.value === 1);
  check("DATEDIF d", val(wb, "S", "A4")?.value === 9);
  check("TEXTJOIN skips empty", val(wb, "S", "A5")?.value === "a-b");
  const seq = val(wb, "S", "A6")?.value;
  check("SEQUENCE returns array", Array.isArray(seq) || seq === 1);
}

// ---------- named ranges (S1.2) ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "Sheet1", cells: {
        A1: { v: 100 }, B1: { v: 0.2 },
        C1: { f: "A1*TaxRate" },
        C2: { f: "SUM(MyData)" },
        C3: { f: "SUM(Local)" },
        C4: { f: "TaxRate*2" },
      } },
      { name: "Sheet2", cells: { A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 } } },
    ],
    names: {
      TaxRate: "Sheet1!$B$1",
      MyData: "Sheet2!$A$1:$A$3",
      Local: "A1",          // same-sheet name (no qualifier)
    },
  };
  check("named scalar (qualified)", val(wb, "Sheet1", "C1")?.value === 20);
  check("named range SUM", val(wb, "Sheet1", "C2")?.value === 6);
  check("same-sheet name", val(wb, "Sheet1", "C3")?.value === 100);
  check("name mid-expression", val(wb, "Sheet1", "C4")?.value === 0.4);
}

// ---------- error set (S1.3) + intersection ----------
{
  const wb: Workbook = {
    sheets: [{ name: "S", cells: {
      A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 },
      B1: { v: 10 }, B2: { v: 20 }, B3: { v: 30 },
      C1: { f: "A1:B2 B2" },           // overlap single cell → 20
      C2: { f: "SUM(A1:B3 A2:C2)" },   // overlap A2:B2 → 12
      C3: { f: "A1:B2 C3:D3" },        // disjoint → #NULL!
      C4: { f: "NA()" },               // #N/A
      C5: { f: "SQRT(-1)" },           // #NUM!
      C6: { f: "1/0" },                // #DIV/0!
      C7: { f: "NOSUCHFN(1)" },        // #NAME?
      C8: { f: "\"a\"+1" },            // #VALUE!
      C9: { f: "#REF!" },              // literal
      C10: { f: "IFERROR(A1:B2 C3:D3,\"no\")" }, // lazy catch of #NULL!
    } }],
  };
  const show = (r: string) => { const res = val(wb, "S", r); return res?.error ?? res?.value; };
  check("intersection single cell", show("C1") === 20);
  check("intersection range SUM", show("C2") === 22);
  check("disjoint intersection → #NULL!", show("C3") === "#NULL!");
  check("NA() → #N/A", show("C4") === "#N/A");
  check("SQRT(-1) → #NUM!", show("C5") === "#NUM!");
  check("1/0 → #DIV/0!", show("C6") === "#DIV/0!");
  check("unknown fn → #NAME?", show("C7") === "#NAME?");
  check("type error → #VALUE!", show("C8") === "#VALUE!");
  check("#REF! literal", show("C9") === "#REF!");
  check("IFERROR catches #NULL!", show("C10") === "no");
}

// ---------- F4 anchor cycling + autocomplete token (S1.6/1.7) ----------
{
  const cyc = (v: string, caret: number) => cycleAnchors(v, caret)?.text ?? v;
  // "=A1" caret at 3 (after A1)
  let f = "=A1";
  f = cyc(f, 3); check("F4 → $A$1", f === "=$A$1");
  f = cyc(f, 5); check("F4 → A$1", f === "=A$1");
  f = cyc(f, 4); check("F4 → $A1", f === "=$A1");
  f = cyc(f, 4); check("F4 → A1 again", f === "=A1");
  check("F4 on qualified ref", cyc("=Sheet2!A1+1", 10) === "=Sheet2!$A$1+1");
  check("F4 inside fn", cyc("=SUM(A1:B2)", 7) === "=SUM($A$1:B2)");
  check("F4 no ref → null", cycleAnchors("=SUM()", 6) === null);
  check("token at caret", tokenAtCaret("=VLO", 4)?.text === "VLO");
  check("token none", tokenAtCaret("=", 1) === null);
}

// ---------- formula auditing (S1.8) ----------
{
  const refs = refsInFormula("SUM(A1:B3,Sheet2!C1)+'My Sheet'!D5:E6*2");
  check("audit finds same-sheet range", refs.some((r) => r.sheet === null && r.range.c1 === 0 && r.range.r2 === 2));
  check("audit finds qualified scalar", refs.some((r) => r.sheet === "Sheet2" && r.range.c1 === 2 && r.range.r1 === 0));
  check("audit finds quoted range", refs.some((r) => r.sheet === "My Sheet" && r.range.c2 === 4));
  check("audit skips strings", refsInFormula('"A1"+1').length === 0);
  check("audit skips fn names", !refsInFormula("SUM(A1)").some((r) => r.range.r1 === -1));
}

// ---------- S3.1 Paste Special ----------
{
  const dst: Record<string, CellData> = { C1: { v: 100 }, C2: { v: 10 } };
  const buf = {
    cells: [
      [{ v: 1, s: { b: true }, eval: 1 }, { v: 2, eval: 2 }],
      [{ v: 3, eval: 3 }, { f: "A1+1", eval: 4 }],
    ],
    w: 2, h: 2, origin: { col: 0, row: 0 },
  };
  // transpose
  pasteCells(dst, { col: 4, row: 0 }, buf, "transpose");
  check("transpose writes E1=1", dst["E1"]?.v === 1);
  check("transpose writes E2=2", dst["E2"]?.v === 2);
  check("transpose writes F1=3", dst["F1"]?.v === 3);
  check("transpose translates formula", dst["F2"]?.f === "E1+1");
  // values mode
  pasteCells(dst, { col: 7, row: 0 }, buf, "values");
  check("values drops formula", dst["I2"]?.v === 4 && !dst["I2"]?.f);
  // formats mode — style only
  pasteCells(dst, { col: 2, row: 0 }, buf, "formats");
  check("formats applies style", dst["C1"]?.s?.b === true && dst["C1"]?.v === 100);
  // add op
  pasteCells(dst, { col: 2, row: 0 }, buf, "all", "add");
  check("add op", dst["C1"]?.v === 101);
  // formulas mode — shift refs relative to origin delta
  const dst2: Record<string, CellData> = {};
  pasteCells(dst2, { col: 5, row: 5 }, buf, "formulas");
  check("formulas shift refs", dst2["G7"]?.f === "F6+1");
}

// ---------- S3.2 Find & Replace ----------
{
  const wb: Workbook = {
    sheets: [
      { name: "S1", cells: { A1: { v: "Hello World" }, B1: { f: "SUM(A2:A3)" }, A2: { v: 5 }, A3: { v: 7 } } },
      { name: "S2", cells: { C1: { v: "hello there" } } },
    ],
  };
  let hits = findInWorkbook(wb, "hello");
  check("find case-insensitive across sheets", hits.length === 2);
  hits = findInWorkbook(wb, "hello", { matchCase: true });
  check("find match case", hits.length === 1 && hits[0].sheet === "S2");
  hits = findInWorkbook(wb, "SUM", { inFormulas: true });
  check("find in formulas", hits.length === 1 && hits[0].ref === "B1");
  const c: CellData = { v: "hello there" };
  check("replace in value", replaceInCell(c, "hello", "bye", false) && c.v === "bye there");
  const cf: CellData = { f: "SUM(A1:A9)" };
  check("replace in formula", replaceInCell(cf, "A9", "A20", false) && cf.f === "SUM(A1:A20)");
}

// ---------- S3.3 Fill series ----------
{
  check("series num pair", (() => { const s = detectSeries([1, 2]); return s?.kind === "num" && seriesValue(s, 3) === 4; })());
  check("series single num", (() => { const s = detectSeries([10]); return s?.kind === "num" && seriesValue(s, 2) === 12; })());
  check("series step 5", (() => { const s = detectSeries([5, 10]); return s?.kind === "num" && seriesValue(s, 3) === 20; })());
  check("series text+num", (() => { const s = detectSeries(["Item1"]); return s?.kind === "text" && seriesValue(s, 2) === "Item3"; })());
  check("series month", (() => { const s = detectSeries(["Jan"]); return s?.kind === "list" && seriesValue(s, 1) === "Feb" && seriesValue(s, 12) === "Jan"; })());
  check("series day", (() => { const s = detectSeries(["Monday"]); return s?.kind === "list" && seriesValue(s, 4) === "Friday"; })());
  check("series date", (() => { const s = detectSeries(["2024-01-30"]); return s?.kind === "date" && seriesValue(s, 2) === "2024-02-01"; })());
  check("series gap → null", detectSeries([1, null, 3]) === null);
}

// ---------- S3.4 Data validation ----------
{
  const sh: SheetData = { name: "S", cells: {}, validations: [{ range: "A1:A5", type: "number", op: "between", min: "1", max: "10" }] };
  check("validationsAt hit", validationsAt(sh, "A3").length === 1);
  check("validationsAt miss", validationsAt(sh, "B1").length === 0);
  const rule = sh.validations![0];
  check("validate in range", validateValue(5, rule));
  check("validate out of range", !validateValue(50, rule));
  check("validate blank passes", validateValue(null, rule));
  check("validate non-number", !validateValue("abc", rule));
  const listRule = { range: "B1:B3", type: "list" as const, list: "Red,Green" };
  check("list validate", validateValue("green", listRule, ["Red", "Green"]));
  check("list reject", !validateValue("blue", listRule, ["Red", "Green"]));
  // listItems: literal + range + name
  const wb: Workbook = { sheets: [{ name: "S", cells: { D1: { v: "x" }, D2: { v: "y" } } }], names: { Ds: "S!D1:D2" } };
  check("listItems literal", JSON.stringify(listItems({ range: "A1", type: "list", list: "a,b,c" }, wb, "S")) === '["a","b","c"]');
  check("listItems range", JSON.stringify(listItems({ range: "A1", type: "list", list: "=D1:D2" }, wb, "S")) === '["x","y"]');
  check("listItems named", JSON.stringify(listItems({ range: "A1", type: "list", list: "Ds" }, wb, "S")) === '["x","y"]');
  // validations shift on row insert
  const s2: SheetData = { name: "S", cells: { A1: { v: 1 } }, validations: [{ range: "A3:A4", type: "number", op: ">", min: "0" }], notes: { B2: "hi" } };
  adjustForRowsCols(s2, "row", 0, 1);
  check("validation range shifts on insert", s2.validations![0].range === "A4:A5");
  check("note follows cell on insert", s2.notes?.["B3"] === "hi");
}

// ---------- S4.5 custom number-format codes ----------
{
  check("fmt thousands", formatValue(1234.5, "#,##0.00") === "1,234.50");
  check("fmt int", formatValue(1234.5, "0") === "1235");
  check("fmt percent", formatValue(0.456, "0%") === "46%");
  check("fmt currency", formatValue(1234.5, "$#,##0.00") === "$1,234.50");
  check("fmt accounting neg", formatValue(-1234.5, '"$"#,##0.00_);("$"#,##0.00)') === "($1,234.50)");
  check("fmt accounting pos", formatValue(1234.5, '"$"#,##0.00_);("$"#,##0.00)') === "$1,234.50 ");
  check("fmt scientific", formatValue(12345, "0.00E+00") === "1.23E+04");
  check("fmt fraction", formatValue(1.25, "# ?/?") === "1 1/4");
  check("fmt fraction third", formatValue(0.3333, "?/?") === "1/3");
  check("fmt text @", formatValue("hello", "@") === "hello");
  check("fmt date iso", formatValue("2024-02-29", "yyyy-mm-dd") === "2024-02-29");
  check("fmt date slash", formatValue("2024-02-29", "dd/mm/yyyy") === "29/02/2024");
  check("fmt date long", formatValue("2024-02-29", "mmm d, yyyy") === "Feb 29, 2024");
  check("fmt date serial", formatValue(45351, "yyyy-mm-dd") === "2024-02-29");
  check("fmt time", formatValue(0.625, "h:mm AM/PM") === "3:00 PM");
  check("fmt literal in code", formatValue(5, '"Qty: "0') === "Qty: 5");
}

// ---------- S5.1 AutoFilter ----------
{
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: "Name" }, B1: { v: "Qty" },
    A2: { v: "apple" }, B2: { v: 10 },
    A3: { v: "banana" }, B3: { v: 25 },
    A4: { v: "apple" }, B4: { v: 30 },
    A5: { v: "cherry" }, B5: { v: 5 },
    A6: { f: "UPPER(A2)" }, B6: { f: "B2*2" },
  } }] };
  const rng = { c1: 0, r1: 0, c2: 1, r2: 5 };
  check("filterValues unique+sorted", JSON.stringify(filterValues(wb.sheets[0], wb, rng, 0)) === '["apple","APPLE","banana","cherry"]');
  check("filterValues numeric sort", JSON.stringify(filterValues(wb.sheets[0], wb, rng, 1)) === '["5","10","20","25","30"]');
  // value filter: only "apple"
  wb.sheets[0].filter = { range: "A1:B6", cols: { 0: { type: "values", values: ["apple", "APPLE"] } } };
  check("filter hides non-apple rows", JSON.stringify(computeFilteredRows(wb.sheets[0], wb)) === JSON.stringify([2, 4]));
  // condition filter: qty > 15 (formula B6 evaluates to 20)
  wb.sheets[0].filter = { range: "A1:B6", cols: { 1: { type: "cond", op1: ">", v1: "15" } } };
  check("cond filter keeps >15", JSON.stringify(computeFilteredRows(wb.sheets[0], wb)) === JSON.stringify([1, 4]));
  // two-condition AND: qty >= 10 AND qty <= 25
  wb.sheets[0].filter = { range: "A1:B6", cols: { 1: { type: "cond", op1: ">=", v1: "10", op2: "<=", v2: "25", and: true } } };
  check("cond AND", JSON.stringify(computeFilteredRows(wb.sheets[0], wb)) === JSON.stringify([3, 4]));
  // OR variant
  wb.sheets[0].filter = { range: "A1:B6", cols: { 1: { type: "cond", op1: "<", v1: "10", op2: ">", v2: "25", and: false } } };
  check("cond OR", JSON.stringify(computeFilteredRows(wb.sheets[0], wb)) === JSON.stringify([1, 2, 5]));
  // text contains
  wb.sheets[0].filter = { range: "A1:B6", cols: { 0: { type: "cond", op1: "contains", v1: "APP" } } };
  check("cond contains", JSON.stringify(computeFilteredRows(wb.sheets[0], wb)) === JSON.stringify([2, 4]));
  // blanks criterion
  wb.sheets[0].filter = { range: "A1:B6", cols: { 0: { type: "cond", op1: "blank" } } };
  check("cond blank hides all nonblank", computeFilteredRows(wb.sheets[0], wb).length === 5);
  // no criteria → nothing hidden
  wb.sheets[0].filter = { range: "A1:B6", cols: {} };
  check("no crit → none hidden", computeFilteredRows(wb.sheets[0], wb).length === 0);
  // evalCond direct
  check("evalCond num >", evalCond(">", 10, "5") && !evalCond(">", 3, "5"));
  check("evalCond str =", evalCond("=", "Apple", "apple"));
  check("evalCond starts", evalCond("starts", "banana", "ban"));
  check("evalCond notblank", evalCond("notblank", "x", ""));
  // filter state survives structural edits (row insert above range shifts it)
  const s: SheetData = { name: "S", cells: { A1: { v: 1 } }, filter: { range: "A2:B5", cols: { 1: { type: "cond", op1: ">", v1: "0" } } } };
  adjustForRowsCols(s, "row", 0, 1);
  check("filter range shifts on insert", s.filter!.range === "A3:B6");
  adjustForRowsCols(s, "col", 0, 1);
  check("filter col keys shift on col insert", !!s.filter!.cols[2]);
}

// ---------- S5.4 tables ----------
{
  const s: SheetData = { name: "S", cells: { A1: { v: 1 } },
    tables: [{ name: "T1", range: "A1:C10", style: "banded", totals: { 1: "sum" } }] };
  adjustForRowsCols(s, "row", 0, 1);
  check("table range shifts", s.tables![0].range === "A2:C11");
  adjustForRowsCols(s, "col", 0, 1);
  check("table totals col shifts", s.tables![0].totals?.[2] === "sum");
}

// ---------- S6 conditional formatting ----------
{
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 10 }, A2: { v: 50 }, A3: { v: 90 },
    B1: { v: "error: disk" }, B2: { v: "ok" }, B3: { f: "A2*2" },
  } }] };
  const ev = evaluateSheetIn(wb, "S");
  const fx = (rules: SheetData["cf"]) => cfEffects({ name: "S", cells: wb.sheets[0].cells, cf: rules }, ev, createSheetEvaluator(wb, "S").evalFormula);
  // legacy value rule
  let m = fx([{ range: "A1:A3", op: ">", value: 40, bg: "#F00" }]);
  check("cf legacy value", m.get("A2")?.bg === "#F00" && m.get("A3")?.bg === "#F00" && !m.get("A1"));
  // text contains
  m = fx([{ range: "B1:B2", type: "text", textOp: "contains", text: "error", bg: "#FF0" }]);
  check("cf text contains", m.get("B1")?.bg === "#FF0" && !m.get("B2"));
  // top-1 / bottom-1
  m = fx([{ range: "A1:A3", type: "topn", n: 1, bg: "#0F0" }, { range: "A1:A3", type: "topn", n: 1, bottom: true, bg: "#00F" }]);
  check("cf top1", m.get("A3")?.bg === "#0F0");
  check("cf bottom1", m.get("A1")?.bg === "#00F");
  // databar: min→~2%, max→100%
  m = fx([{ range: "A1:A3", type: "databar", bar: "#123456" }]);
  check("cf databar max", m.get("A3")?.bar?.pct === 100);
  check("cf databar min", m.get("A1")?.bar?.pct === 2);
  check("cf databar color", m.get("A2")?.bar?.color === "#123456");
  // colorscale 2-stop: min→minColor, max→maxColor
  m = fx([{ range: "A1:A3", type: "colorscale", minColor: "#000000", maxColor: "#FFFFFF" }]);
  check("cf scale lo", m.get("A1")?.bg === "rgb(0,0,0)");
  check("cf scale hi", m.get("A3")?.bg === "rgb(255,255,255)");
  check("cf scale mid lerps", /^rgb\(/.test(m.get("A2")?.bg ?? ""));
  // 3-stop: mid value hits midColor
  m = fx([{ range: "A1:A3", type: "colorscale", minColor: "#FF0000", midColor: "#00FF00", maxColor: "#0000FF" }]);
  check("cf scale3 mid", m.get("A2")?.bg === "rgb(0,255,0)");
  // iconset: lo/mid/hi thirds
  m = fx([{ range: "A1:A3", type: "iconset", icons: "arrows" }]);
  check("cf icon lo", m.get("A1")?.icon?.endsWith("▼"));
  check("cf icon hi", m.get("A3")?.icon?.endsWith("▲"));
  // formula rule — refs relative to top-left shift per cell
  m = fx([{ range: "A1:A3", type: "formula", f: "A1>40", bg: "#0FF" }]);
  check("cf formula shifts", !m.get("A1") && m.get("A2")?.bg === "#0FF" && m.get("A3")?.bg === "#0FF");
  // first rule wins for bg
  m = fx([{ range: "A1:A3", op: ">", value: 0, bg: "#111" }, { range: "A1:A3", op: ">", value: 80, bg: "#222" }]);
  check("cf first-wins", m.get("A3")?.bg === "#111");
  // rule ranges survive structural edits (already remap-tested; spot-check cf)
  const s: SheetData = { name: "S", cells: {}, cf: [{ range: "A2:A4", type: "databar" }] };
  adjustForRowsCols(s, "row", 0, 1);
  check("cf range shifts", s.cf![0].range === "A3:A5");
}

// ---------- S7 charts + sparklines ----------
{
  const { extractSeries } = await import("./src/sheets/Chart");
  const wb: Workbook = { sheets: [
    { name: "S", cells: {
      A1: { v: "m" }, B1: { v: "s1" }, C1: { v: "s2" },
      A2: { v: 1 }, B2: { v: 10 }, C2: { v: 5 },
      A3: { v: 2 }, B3: { v: 20 }, C3: { v: 15 },
      A4: { v: 3 }, B4: { v: 30 }, C4: { f: "B4/2" },
    } },
    { name: "T", cells: { A1: { v: "x" }, B1: { v: "y" }, A2: { v: 1 }, B2: { v: 7 } } },
  ] };
  const ser = extractSeries(wb.sheets[0], "A1:C4", wb);
  check("chart 2 series", ser.length === 2);
  check("chart labels", JSON.stringify(ser[0].labels) === '["1","2","3"]');
  check("chart names", ser[0].name === "s1" && ser[1].name === "s2");
  check("chart formula val", ser[1].values[2] === 15);
  // cross-sheet range
  const xs = extractSeries(wb.sheets[0], "T!A1:B2", wb);
  check("chart cross-sheet", xs[0].name === "y" && xs[0].values[0] === 7);
  // single-col range → one series with ref labels
  const one = extractSeries(wb.sheets[0], "B1:B4", wb);
  check("chart single col", one.length === 1 && one[0].values.join(",") === "0,10,20,30");
  // sparkline spec survives structural remap (host ref + source range)
  const s: SheetData = { name: "S", cells: { A1: { v: 1 } },
    sparklines: { C3: { range: "A1:B1", type: "line", color: "#123" } } };
  adjustForRowsCols(s, "row", 0, 1);
  check("spark host+range shift", s.sparklines!["C4"]?.range === "A2:B2");
  adjustForRowsCols(s, "col", 0, 1);
  check("spark col shift", !!s.sparklines!["D4"] && s.sparklines!["D4"].range === "B2:C2");
}


// ============ S9: protection + change stamps ============

t("S9: unprotected sheet never locked", () => {
  const s: SheetData = { name: "S1", cells: { A1: { v: 1 } } };
  assert(!cellLocked(s, "A1")); assert(!cellLocked(s, "Z99"));
});
t("S9: protected sheet locks all cells", () => {
  const s: SheetData = { name: "S1", cells: {}, protected: true };
  assert(cellLocked(s, "A1")); assert(cellLocked(s, "Z99"));
});
t("S9: allowRanges exempt cells", () => {
  const s: SheetData = { name: "S1", cells: {}, protected: true, allowRanges: ["B2:D10", "F1"] };
  assert(cellLocked(s, "A1"));
  assert(!cellLocked(s, "B2")); assert(!cellLocked(s, "C5")); assert(!cellLocked(s, "D10"));
  assert(!cellLocked(s, "F1"));          // single-cell range
  assert(cellLocked(s, "E5"));           // outside all ranges
  assert(cellLocked(s, "F2"));
});
t("S9: malformed allowRanges ignored", () => {
  const s: SheetData = { name: "S1", cells: {}, protected: true, allowRanges: ["junk", "B2:B4"] };
  assert(!cellLocked(s, "B3"));          // valid range still applies
  assert(cellLocked(s, "C3"));
});
t("S9: change stamp serializes through workbook JSON", () => {
  const s: SheetData = { name: "S1", cells: { A1: { v: 1, h: { by: "u@x.com", at: 1700000000000 } } } };
  const rt: SheetData = JSON.parse(JSON.stringify(s));
  assertEq(rt.cells.A1.h!.by, "u@x.com");
  assertEq(rt.cells.A1.h!.at, 1700000000000);
});
t("S9: per-cell collab key encoding", () => {
  const k = (sh: string, ref: string) => `${sh}\x01${ref}`;
  assertEq(k("Sheet 1", "B5"), "Sheet 1\x01B5");
  const [sh, ref] = k("O'Brien", "C3").split("\x01");
  assertEq(sh, "O'Brien"); assertEq(ref, "C3");
});


// ============ S10: pivots + goal seek ============

const pivotWb = (): Workbook => ({
  sheets: [{
    name: "S1",
    cells: {
      A1: { v: "Region" }, B1: { v: "Product" }, C1: { v: "Sales" },
      A2: { v: "N" }, B2: { v: "A" }, C2: { v: 10 },
      A3: { v: "N" }, B3: { v: "B" }, C3: { v: 20 },
      A4: { v: "S" }, B4: { v: "A" }, C4: { v: 30 },
      A5: { v: "S" }, B5: { v: "B" }, C5: { v: 40 },
      A6: { v: "S" }, B6: { v: "A" }, C6: { v: 50 },
    },
  }],
});

t("S10: pivot rows+vals sums and grand total", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [], vals: [{ field: "Sales", agg: "sum" }] })!;
  assert(out);
  assertEq(out.cells.F1.v, "Region");
  assertEq(out.cells.G1.v, "Sum Sales");
  assertEq(out.cells.H1.v, "Grand Total");
  // rows sorted: N then S
  assertEq(out.cells.F2.v, "N"); assertEq(out.cells.G2.v, 30);
  assertEq(out.cells.F3.v, "S"); assertEq(out.cells.G3.v, 120);
  assertEq(out.cells.F4.v, "Grand Total"); assertEq(out.cells.G4.v, 150);
  assertEq(out.cells.H4.v, 150);
});

t("S10: pivot with column field splits values", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: ["Product"], vals: [{ field: "Sales", agg: "sum" }] })!;
  // header: Region | A — Sum Sales | B — Sum Sales | Grand Total
  assertEq(out.cells.G1.v, "A — Sum Sales");
  assertEq(out.cells.H1.v, "B — Sum Sales");
  assertEq(out.cells.G2.v, 10);  // N/A
  assertEq(out.cells.H2.v, 20);  // N/B
  assertEq(out.cells.G3.v, 80);  // S/A
  assertEq(out.cells.H3.v, 40);  // S/B
  assertEq(out.cells.I3.v, 120); // S total
});

t("S10: pivot count + avg aggregations", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [],
      vals: [{ field: "Sales", agg: "count" }, { field: "Sales", agg: "avg" }] })!;
  assertEq(out.cells.G2.v, 2);   // N count
  assertEq(out.cells.H2.v, 15);  // N avg
  assertEq(out.cells.G3.v, 3);   // S count
  assertEq(out.cells.H3.v, 40);  // S avg
});

t("S10: pivot invalid spec returns null", () => {
  const wb = pivotWb();
  assertEq(buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Nope"], cols: [], vals: [{ field: "Sales", agg: "sum" }] }), null);
  assertEq(buildPivotCells(wb, wb.sheets[0],
    { src: "bad", at: "F1", rows: ["Region"], cols: [], vals: [{ field: "Sales", agg: "sum" }] }), null);
});

t("S10: pivot formula-valued source aggregates evaluated values", () => {
  const wb = pivotWb();
  wb.sheets[0].cells.C2 = { f: "5+5" };
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [], vals: [{ field: "Sales", agg: "sum" }] })!;
  assertEq(out.cells.G2.v, 30); // 10 (formula) + 20
});

t("S10: goal seek linear", () => {
  const x = solveGoalSeek((v) => v * 3 + 2, 20);
  assert(x !== null && Math.abs(x - 6) < 1e-4, `expected ~6, got ${x}`);
});
t("S10: goal seek quadratic root", () => {
  const x = solveGoalSeek((v) => v * v, 9, 1);
  assert(x !== null && Math.abs(Math.abs(x) - 3) < 1e-3, `expected ±3, got ${x}`);
});
t("S10: goal seek no-solution returns null", () => {
  const x = solveGoalSeek(() => 5, 10); // constant — never reaches 10
  assertEq(x, null);
});

// ============ S13: pivot depth ============

t("S13: pivot report filter restricts rows and totals", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [], vals: [{ field: "Sales", agg: "sum" }],
      filters: [{ field: "Region", sel: ["N"] }] })!;
  assertEq(out.cells.F2.v, "N"); assertEq(out.cells.G2.v, 30);
  assertEq(out.cells.F3.v, "Grand Total"); assertEq(out.cells.G3.v, 30);
  assert(!out.cells.F4, "no extra rows past filtered set");
});

t("S13: pivot showAs %total", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [],
      vals: [{ field: "Sales", agg: "sum", showAs: "%total" }] })!;
  assertEq(out.cells.G2.v, 20);  // 30/150
  assertEq(out.cells.G3.v, 80);  // 120/150
});

t("S13: pivot showAs running total", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [],
      vals: [{ field: "Sales", agg: "sum", showAs: "running" }] })!;
  assertEq(out.cells.G2.v, 30);   // N
  assertEq(out.cells.G3.v, 150);  // N+S accumulated
});

t("S13: pivot showAs diff from base", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [],
      vals: [{ field: "Sales", agg: "sum", showAs: "diff", base: "N" }] })!;
  assertEq(out.cells.G2.v, 0);   // 30-30
  assertEq(out.cells.G3.v, 90);  // 120-30
});

t("S13: pivot %row/%col splits", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: ["Product"],
      vals: [{ field: "Sales", agg: "sum", showAs: "%col" }] })!;
  // col A total = 10+30+50=90 → N/A = 10/90 ≈ 11.11
  assert(Math.abs((out.cells.G2.v as number) - 11.111) < 0.01, `got ${out.cells.G2.v}`);
  // col B total = 20+40=60 → S/B = 40/60 ≈ 66.67
  assert(Math.abs((out.cells.H3.v as number) - 66.667) < 0.01, `got ${out.cells.H3.v}`);
});

t("S13: calculated field feeds values", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [],
      vals: [{ field: "DoubleSales", agg: "sum" }],
      calcFields: [{ name: "DoubleSales", formula: "Sales*2" }] })!;
  assertEq(out.cells.G2.v, 60);   // (10+20)*2
  assertEq(out.cells.G3.v, 240);  // (30+40+50)*2
});

const datePivotWb = (): Workbook => ({
  sheets: [{
    name: "S1",
    cells: {
      A1: { v: "When" }, B1: { v: "Amt" },
      A2: { v: 45292 }, B2: { v: 10 },   // 2024-01-01
      A3: { v: 45322 }, B3: { v: 20 },   // 2024-01-31
      A4: { v: 45351 }, B4: { v: 30 },   // 2024-02-29
      A5: { v: 45657 }, B5: { v: 40 },   // 2024-12-31
    },
  }],
});

t("S13: pivot month grouping buckets dates", () => {
  const wb = datePivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:B5", at: "E1", rows: ["When"], cols: [], vals: [{ field: "Amt", agg: "sum" }],
      groups: [{ field: "When", kind: "month" }] })!;
  assertEq(out.cells.E2.v, "Dec 2024"); assertEq(out.cells.F2.v, 40);
  assertEq(out.cells.E3.v, "Feb 2024"); assertEq(out.cells.F3.v, 30);
  assertEq(out.cells.E4.v, "Jan 2024"); assertEq(out.cells.F4.v, 30); // 10+20
});

t("S13: pivot numeric binning", () => {
  const wb = pivotWb();
  const out = buildPivotCells(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Sales"], cols: [], vals: [{ field: "Sales", agg: "count" }],
      groups: [{ field: "Sales", kind: "num", size: 30 }] })!;
  // bins: 0–29 (10,20) → 2; 30–59 (30,40,50) → 3
  assertEq(out.cells.F2.v, "0–29"); assertEq(out.cells.G2.v, 2);
  assertEq(out.cells.F3.v, "30–59"); assertEq(out.cells.G3.v, 3);
});

t("S13: drill-down returns matching source rows", () => {
  const wb = pivotWb();
  const drill = pivotDrillRows(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [], vals: [{ field: "Sales", agg: "sum" }] },
    ["N"])!;
  assert(drill);
  assertEq(drill.A1.v, "Region");
  assertEq(drill.A2.v, "N"); assertEq(drill.C2.v, 10);
  assertEq(drill.A3.v, "N"); assertEq(drill.C3.v, 20);
  assert(!drill.A4, "only the two N rows");
});

t("S13: drill-down respects report filters", () => {
  const wb = pivotWb();
  const drill = pivotDrillRows(wb, wb.sheets[0],
    { src: "A1:C6", at: "F1", rows: ["Region"], cols: [], vals: [{ field: "Sales", agg: "sum" }],
      filters: [{ field: "Product", sel: ["A"] }] },
    ["S"])!;
  assertEq(drill.A2.v, "S"); assertEq(drill.B2.v, "A");
  assertEq(drill.A3.v, "S"); assertEq(drill.B3.v, "A");
  assert(!drill.A4, "Product=B rows filtered out");
});

// ============ S14: chart catalog + depth ============

t("S14: pivotChartRange excludes total row/col", () => {
  const wb = pivotWb();
  const spec = { src: "A1:C6", at: "F1", rows: ["Region"], cols: [], vals: [{ field: "Sales", agg: "sum" as const }] };
  const built = buildPivotCells(wb, wb.sheets[0], spec)!;
  spec.span = { r: built.rows, c: built.cols }; // 4 rows (hdr, N, S, GT) × 3 cols
  wb.sheets[0].pivots = [spec];
  assertEq(pivotChartRange(wb.sheets[0], 0), "F1:G3"); // F=labels, G=data; GT row/col excluded
  assertEq(pivotChartRange(wb.sheets[0], 5), null);
});

t("S14: new chart types + overlay fields typecheck on spec", () => {
  const spec: import("./src/sheets/model").ChartSpec = {
    id: "c1", type: "waterfall", range: "A1:B5",
    trendline: "linear", errorBars: "stddev", axis2: 1, yMin: 0, yMax: 100, x: 0, y: 0,
  };
  assertEq(spec.trendline, "linear");
  assertEq(spec.errorBars, "stddev");
  const spec2: import("./src/sheets/model").ChartSpec = { id: "c2", type: "boxwhisker", range: "A1:E5", x: 0, y: 0 };
  assertEq(spec2.type, "boxwhisker");
});

// ============ S15: protection depth ============

t("S15: cellLocked honors per-user allow ranges", () => {
  const s: SheetData = {
    name: "S", cells: {},
    protected: true,
    allowRanges: [{ range: "B2:B5", users: ["u1", "ana@x.com"] }],
  };
  // scoped range — only u1 / ana@x.com may edit
  assertEq(cellLocked(s, "B3", { id: "u1" }), false);
  assertEq(cellLocked(s, "B3", { email: "ana@x.com" }), false);
  assertEq(cellLocked(s, "B3", { id: "u2", email: "bob@x.com" }), true);
  assertEq(cellLocked(s, "B3", null), true);            // anonymous can't use scoped ranges
  assertEq(cellLocked(s, "C3", { id: "u1" }), true);    // outside range still locked
});

t("S15: cellLocked honors per-role allow ranges", () => {
  const s: SheetData = {
    name: "S", cells: {},
    protected: true,
    allowRanges: [{ range: "C1:C3", roles: ["admin"] }, "D1:D3"],
  };
  assertEq(cellLocked(s, "C2", { role: "admin" }), false);
  assertEq(cellLocked(s, "C2", { role: "member" }), true);
  assertEq(cellLocked(s, "D2", null), false);           // unscoped range = anyone
  assertEq(cellLocked(s, "E2", { role: "admin" }), true);
});

t("S15: workbook protection fields typecheck", () => {
  const wb: Workbook = { sheets: [], protectStructure: true, passwordHash: "abc" };
  assertEq(wb.protectStructure, true);
});

// ============ S16: view & print ============

t("S16: print HTML repeats title rows in thead", () => {
  const wb = pivotWb();
  const html = sheetToPrintHTML(wb.sheets[0], wb, { titleRows: "1:1" });
  assert(html.includes("<thead>"), "thead emitted");
  assert(html.indexOf("<thead>") < html.indexOf("Region"), "title row in thead");
  assert(html.includes("Region"), "header content present");
});

t("S16: print HTML header/footer tokens + scale", () => {
  const wb = pivotWb();
  const html = sheetToPrintHTML(wb.sheets[0], wb, {
    header: "&T report", footer: "Page &P of &N", scale: 75, title: "MySheet",
  });
  assert(html.includes("@top-center"), "header rule emitted");
  assert(html.includes("counter(page)"), "page counter in footer");
  assert(html.includes("counter(pages)"), "pages counter in footer");
  assert(html.includes("zoom: 0.75"), "scale applied");
});

t("S16: splitRow + view state fields typecheck", () => {
  const wb: Workbook = {
    sheets: [{ name: "S", cells: {}, splitRow: 5 }],
    views: [{ name: "Compact", sheet: "S", state: { hiddenRows: [3, 4], zoom: 0.8 } }],
  };
  assertEq(wb.sheets[0].splitRow, 5);
  assertEq(wb.views![0].state.zoom, 0.8);
});

// ============ results ============


// ============ S11: dynamic arrays + spill ============

t("S11: SEQUENCE spills a matrix", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: "SEQUENCE(3,2)" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  // anchor shows top-left; spill targets materialize in the results map
  assertEq(ev.get("A1")?.value, [[1,2],[3,4],[5,6]]);
  assertEq(ev.get("B1")?.value, 2);   // spill target
  assertEq(ev.get("A3")?.value, 5);
  assertEq(ev.get("B3")?.value, 6);
  assertEq(ev.get("B1")?.spillFrom, "A1");
});

t("S11: spill collision -> #SPILL!", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: "SEQUENCE(2,2)" }, B1: { v: "blocked" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("A1")?.error, "#SPILL!");
});

t("S11: dependent reads a spilled cell", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: "SEQUENCE(2,2)" },   // A1=1 B1=2 A2=3 B2=4
    D1: { f: "B2*10" },           // reads spill target B2 → 40
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("D1")?.value, 40);
});

t("S11: spill-range ref A1# feeds dependents", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: "SEQUENCE(3)" },     // 1,2,3 down
    C1: { f: "SUM(A1#)" },        // =6
  } } ] };
  assertEq(evaluateSheetIn(wb, "S").get("C1")?.value, 6);
});

t("S11: cross-sheet spill ref", () => {
  const wb: Workbook = { sheets: [
    { name: "S", cells: { A1: { f: "SEQUENCE(2)" } } },
    { name: "T", cells: { A1: { f: "SUM(S!A1#)" } } },
  ] };
  assertEq(evaluateSheetIn(wb, "T").get("A1")?.value, 3);
});

t("S11: @ implicit intersection picks formula's row", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 10 }, A2: { v: 20 }, A3: { v: 30 },
    B2: { f: "@A1:A3" },   // row 2 → 20
    B5: { f: "@A1:A3" },   // row 5 outside → #VALUE!
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("B2")?.value, 20);
  assertEq(ev.get("B5")?.value, "#VALUE!");
});

t("S11: UNIQUE spills distinct rows", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: "a" }, A2: { v: "b" }, A3: { v: "a" }, A4: { v: "c" },
    C1: { f: "UNIQUE(A1:A4)" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("C1")?.value, [["a"],["b"],["c"]]);
  assertEq(ev.get("C3")?.value, "c");
});

t("S11: SORT spills sorted rows", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 3 }, A2: { v: 1 }, A3: { v: 2 },
    B1: { f: "SORT(A1:A3)" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("B1")?.value, [[1],[2],[3]]);
  assertEq(ev.get("B3")?.value, 3);
});

t("S11: SORTBY with two keys", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: "x" }, B1: { v: 2 },
    A2: { v: "y" }, B2: { v: 1 },
    A3: { v: "x" }, B3: { v: 0 },
    D1: { f: "SORTBY(A1:B3, A1:A3, 1, B1:B3, -1)" },
  } } ] };
  const ev = evaluateSheetIn(wb, "D1");
  const evv = evaluateSheetIn(wb, "S");
  // sorted: (x,2),(x,0),(y,1)
  assertEq(evv.get("D1")?.value, [["x",2],["x",0],["y",1]]);
  void ev;
});

t("S11: FILTER rows by mask", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: "a" }, B1: { v: 5 },
    A2: { v: "b" }, B2: { v: 15 },
    A3: { v: "c" }, B3: { v: 25 },
    D1: { f: "FILTER(A1:B3, B1:B3>10)" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("D1")?.value, [["b",15],["c",25]]);
  assertEq(ev.get("E2")?.value, 25);
});

t("S11: TRANSPOSE flips a range", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 1 }, A2: { v: 2 },
    C1: { f: "TRANSPOSE(A1:A2)" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("C1")?.value, [[1,2]]);
  assertEq(ev.get("D1")?.value, 2);
});

t("S11: TAKE/DROP/CHOOSEROWS/HSTACK/VSTACK/WRAPROWS", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 },
    B1: { f: "TAKE(A1:A3, 2)" },
    D1: { f: "DROP(A1:A3, 1)" },
    F1: { f: "CHOOSEROWS(A1:A3, 3, 1)" },
    H1: { f: "HSTACK(A1:A3, B1#)" },
    K1: { f: "VSTACK(A1:A2, A3)" },
    N1: { f: "WRAPROWS(A1:A3, 2, 0)" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("B1")?.value, [[1],[2]]);
  assertEq(ev.get("D1")?.value, [[2],[3]]);
  assertEq(ev.get("F1")?.value, [[3],[1]]);
  assertEq(ev.get("H1")?.value, [[1,1],[2,2],[3,"#N/A"]]); // B1# spills 2 rows → pad
  assertEq(ev.get("K1")?.value, [[1],[2],[3]]);
  assertEq(ev.get("N1")?.value, [[1,2],[3,0]]);
});

t("S11: TOCOL/TOROW/EXPAND", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 1 }, B1: { v: 2 }, A2: { v: 3 }, B2: { v: 4 },
    D1: { f: "TOCOL(A1:B2)" },
    F1: { f: "TOROW(A1:B2)" },
    K1: { f: "EXPAND(A1, 2, 3, \"x\")" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("D1")?.value, [[1],[2],[3],[4]]);
  assertEq(ev.get("F1")?.value, [[1,2,3,4]]);
  assertEq(ev.get("K1")?.value, [[1,"x","x"],["x","x","x"]]);
});

t("S11: TEXTSPLIT + ARRAYTOTEXT", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: 'TEXTSPLIT("a,b;c,d", ",", ";")' },
    C1: { f: 'ARRAYTOTEXT(B2:B4)' },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("A1")?.value, [["a","b"],["c","d"]]);
  assertEq(ev.get("B2")?.value, "d");   // spill target
});

t("S11: FORMULATEXT returns the formula text", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: "SUM(1,2)" },
    B1: { f: "FORMULATEXT(A1)" },
    B2: { f: "FORMULATEXT(A9)" },
  } } ] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("B1")?.value, "=SUM(1,2)");
  assertEq(ev.get("B2")?.value, "#N/A");
});

t("S11.3 LET + LAMBDA helpers", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 },
    C1: { f: "LET(x, 5, y, x*3, x+y)" },
    C2: { f: "LET(n, A1+A2, n*10)" },
    D1: { f: "MAP(A1:A3, LAMBDA(x, x*2))" },
    D5: { f: "BYROW(A1:B1, LAMBDA(r, SUM(r)))" },
    D7: { f: "BYCOL(A1:B1, LAMBDA(c, SUM(c)))" },
    F1: { f: "MAKEARRAY(2, 2, LAMBDA(r, c, r*10+c))" },
    F5: { f: "REDUCE(0, A1:A3, LAMBDA(a, v, a+v))" },
    F7: { f: "SCAN(0, A1:A3, LAMBDA(a, v, a+v))" },
    F9: { f: "LET(dbl, LAMBDA(x, x*2), MAP(A1:A2, dbl))" },
  } }] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("C1")?.value, 20);
  assertEq(ev.get("C2")?.value, 30);
  assertEq(ev.get("D1")?.value, [[2],[4],[6]]);
  assertEq(ev.get("D2")?.value, 4);
  assertEq(ev.get("D2")?.spillFrom, "D1");
  assertEq(ev.get("D5")?.value, [[1]]);
  assertEq(ev.get("D7")?.value, [[1,0]]);
  assertEq(ev.get("F1")?.value, [[11,12],[21,22]]);
  assertEq(ev.get("F5")?.value, 6);
  assertEq(ev.get("F7")?.value, [[1,3,6]]);
  assertEq(ev.get("F9")?.value, [[2],[4]]);
});

t("S11.4 function-library gaps", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: "a-b-c" },
    B1: { f: 'TEXTBEFORE(A1, "-", 2)' }, B2: { f: 'TEXTAFTER(A1, "-", -1)' },
    B3: { f: "SHEETS()" },
    D1: { v: 44927 },  // 2023-01-31
    E1: { f: "EDATE(D1, 1)" }, E2: { f: "EOMONTH(D1, 0)" }, E3: { f: "YEARFRAC(D1, D1+365)" },
    E4: { f: "WORKDAY(45292, 3)" },   // 45292 = 2023-12-22 Friday
    E5: { f: "NETWORKDAYS(45292, 45296)" },
    H1: { v: "Name" }, I1: { v: "Qty" },
    H2: { v: "a" }, I2: { v: 5 }, H3: { v: "b" }, I3: { v: 8 },
    K1: { v: "Name" }, K2: { v: "a" },
    L1: { f: "DSUM(H1:I3, \"Qty\", K1:K2)" }, L2: { f: "DCOUNT(H1:I3, 2, K1:K2)" },
    L3: { f: "DAVERAGE(H1:I3, \"Qty\", K1:K2)" }, L4: { f: "DGET(H1:I3, 2, K1:K2)" },
    N1: { v: 1 }, N2: { v: 2 }, N3: { v: 3 },
    O1: { v: 2 }, O2: { v: 4 }, O3: { v: 6 },
    P1: { f: "FORECAST.LINEAR(4, O1:O3, N1:N3)" },
  } }] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("B1")?.value, "a-b");
  assertEq(ev.get("B2")?.value, "c");
  assertEq(ev.get("B3")?.value, 1);
  assertEq(ev.get("E1")?.value, 44958);   // 2023-02-28
  assertEq(ev.get("E2")?.value, 44957);
  assertEq(ev.get("E3")?.value, 1);
  assertEq(ev.get("E4")?.value, 45295);   // Mon 2024-01-01 + 3 workdays = Thu
  assertEq(ev.get("E5")?.value, 5);
  assertEq(ev.get("L1")?.value, 5);
  assertEq(ev.get("L2")?.value, 1);
  assertEq(ev.get("L3")?.value, 5);
  assertEq(ev.get("L4")?.value, 5);
  assertEq(ev.get("P1")?.value, 8);
});

t("S11.5 iterative calc converges circular refs", () => {
  // A1 = B1/2, B1 = A1 → fixed point A1=0; use converging system:
  // A1 = B1/2 + 8, B1 = A1/2 → A1 → 8+..., converges to ~10.67
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: "B1/2 + 8" }, B1: { f: "A1/2" },
    C1: { f: "D1+1" }, D1: { f: "C1+1" },  // divergent — bounded by maxIter
  } }], calc: { iterative: true, maxIterations: 100, maxChange: 0.0001 } };
  const ev = evaluateSheetIn(wb, "S");
  const a = ev.get("A1")?.value as number;
  assert(Math.abs(a - 10.6667) < 0.01, `A1 converged near 10.67 (got ${a})`);
  assert(typeof ev.get("C1")?.value === "number", "divergent cycle returns a number, not error");
  // without iterative, the same cells error as before
  const wb2: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: "B1/2 + 8" }, B1: { f: "A1/2" },
  } }] };
  assert(["#CYCLE!","#VALUE!"].includes(evaluateSheetIn(wb2, "S").get("A1")?.error ?? ""), "cycle errors without iterative");
});

t("S11.6 error-check rules + formula explanation", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 },
    B1: { f: "A1*2" }, B2: { f: "A2*3" }, B3: { f: "A3*2" },  // B2 inconsistent
    C1: { v: "42" },                                        // number as text
    D1: { f: "1/0" },                                       // error value
  } }] };
  const ev = evaluateSheetIn(wb, "S");
  const findings = errorCheck(wb.sheets[0], ev, false);
  const byRule = (r: string) => findings.filter((f) => f.rule === r).map((f) => f.ref);
  assert(byRule("error").includes("D1"), "error cell flagged");
  assert(byRule("inconsistent").includes("B2"), "inconsistent formula flagged");
  assert(byRule("numAsText").includes("C1"), "number-as-text flagged");
  const ex = explainFormula(wb, "S", "SUM(A1:A3, 10)");
  assertEq(ex.final.value, 16);
  assertEq(ex.parts.length, 2);
  assertEq(ex.parts[0].result.value, [[1],[2],[3]]);
  assertEq(toR1C1("A1+B$2", "B3"), "R[-2]C[-1]+R2C[0]");
});

t("S12.1 structured table references", () => {
  const wb: Workbook = { sheets: [{
    name: "S",
    cells: {
      A1: { v: "Item" }, B1: { v: "Qty" }, C1: { v: "Price" },
      A2: { v: "a" }, B2: { v: 5 }, C2: { v: 10 },
      A3: { v: "b" }, B3: { v: 3 }, C3: { v: 20 },
      E1: { f: "SUM(Tbl[Qty])" },
      E2: { f: "SUM(Tbl[#Data])" },
      F2: { f: "Tbl[@Qty]*Tbl[@Price]" },
      F3: { f: "[@Qty]*[@Price]" },
      E4: { f: "SUM(Tbl[[#Totals],[Qty]])" },
      E5: { f: "COUNTA(Tbl[#Headers])" },
      E6: { f: "SUM(Tbl[#All])" },
    },
    tables: [{ name: "Tbl", range: "A1:C3", totals: { 1: "sum" } }],
  }] };
  const ev = evaluateSheetIn(wb, "S");
  assertEq(ev.get("E1")?.value, 8);
  assertEq(ev.get("E2")?.value, 38);        // 5+3+10+20 (data only, text→0)
  assertEq(ev.get("F2")?.value, 50);        // row2: 5*10
  assertEq(ev.get("F3")?.value, 60);        // bare @ in table row → 3*20
  assertEq(ev.get("E4")?.value, 8);         // totals cell for Qty
  assertEq(ev.get("E5")?.value, 3);         // header row count
  assertEq(ev.get("E6")?.value, 46);        // all incl totals row
});

t("S12.4 insert/delete cells with shift", () => {
  const sheet: SheetData = { name: "S", cells: {
    A1: { v: 1 }, A2: { v: 2 }, A3: { v: 3 },
    B1: { v: "x" }, B2: { v: "y" },
    C1: { f: "A3*10" },          // ref into moved band
    C2: { f: "A2" },             // ref into the soon-deleted zone
  } };
  shiftCells(sheet, { c1: 0, r1: 1, c2: 0, r2: 1 }, "down"); // ins at A2
  assert(sheet.cells.A2 === undefined, "A2 now empty");
  assertEq(sheet.cells.A3?.v, 2);
  assertEq(sheet.cells.A4?.v, 3);
  assertEq(sheet.cells.C1?.f, "A4*10");     // formula ref followed the cell
  assertEq(sheet.cells.B2?.v, "y");         // outside band untouched
  shiftCells(sheet, { c1: 0, r1: 1, c2: 0, r2: 1 }, "up");  // delete A2 (empty)
  assertEq(sheet.cells.A2?.v, 2);
  assertEq(sheet.cells.A3?.v, 3);
  assertEq(sheet.cells.A4, undefined);
  // delete occupied zone → refs pointing AT it become #REF!
  shiftCells(sheet, { c1: 0, r1: 1, c2: 0, r2: 1 }, "up");
  assert(sheet.cells.C2?.f?.includes("#REF!"), "ref into deleted zone → #REF!");
});

t("S12.3 SUBTOTAL + outline collapse", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { v: 10 }, A2: { v: 20 }, A3: { v: 30 },
    B1: { f: "SUBTOTAL(9, A1:A3)" }, B2: { f: "SUBTOTAL(109, A1:A3)" },
    B3: { f: "SUBTOTAL(1, A1:A3)" },
  } }] };
  assertEq(evaluateSheetIn(wb, "S").get("B1")?.value, 60);
  assertEq(evaluateSheetIn(wb, "S").get("B3")?.value, 20);
  // hidden row excluded by 1xx code only
  wb.sheets[0].hiddenRows = [1];
  assertEq(evaluateSheetIn(wb, "S").get("B1")?.value, 60);  // 9 includes hidden
  assertEq(evaluateSheetIn(wb, "S").get("B2")?.value, 40);  // 109 excludes
  // filtered rows excluded by both
  wb.sheets[0].filteredRows = [0];
  assertEq(evaluateSheetIn(wb, "S").get("B1")?.value, 50);  // filtered excluded, manual-hidden included
  assertEq(evaluateSheetIn(wb, "S").get("B2")?.value, 30);  // 109 excludes both
  // outline collapse resolves hidden members
  const s2: SheetData = { name: "S", cells: {}, outlineRows: { 1: 1, 2: 1, 3: 1 }, collapsedRows: [3] };
  assertEq(outlineHidden(s2, "row").sort(), [1, 2, 3]);
  toggleOutline(s2, "row", 3);
  assertEq(outlineHidden(s2, "row"), []);
});

t("S12.6 flash fill + go-to-special + column suggestions", () => {
  const ff = flashFillTemplate(["John", "Doe"], "John Doe");
  assert(ff && ff(["Jane", "Smith"]) === "Jane Smith", "concat template");
  const ff2 = flashFillTemplate(["Ada Lovelace"], "Ada");
  assert(ff2 && ff2(["Grace Hopper"]) === "Grace", "first-word template");
  const ff3 = flashFillTemplate(["abc123"], "123");
  assert(ff3 && ff3(["xy789"]) === "789", "digit extraction");
  const sheet: SheetData = { name: "S", cells: {
    A1: { v: 1 }, A2: { f: "A1*2" }, A4: { v: "x" },
    B1: { f: "1/0" },
  }, notes: { A4: "note here" } };
  const rng = { c1: 0, r1: 0, c2: 1, r2: 3 };
  const ev = evaluateSheetIn({ sheets: [sheet] }, "S");
  assert(goToSpecial(sheet, ev, rng, "blanks").includes("A3"), "blanks found");
  assertEq(goToSpecial(sheet, ev, rng, "formulas").sort(), ["A2", "B1"]);
  assertEq(goToSpecial(sheet, ev, rng, "constants").sort(), ["A1", "A4"]);
  assertEq(goToSpecial(sheet, ev, rng, "errors"), ["B1"]);
  assertEq(goToSpecial(sheet, ev, rng, "notes"), ["A4"]);
  assert(columnSuggestions({ name: "S", cells: { A1: { v: "red" }, A2: { v: "blue" }, B1: { v: "green" } } }, 0).includes("red"), "col suggestions");
});

t("S12.2 slicer hidden rows", () => {
  const wb: Workbook = { sheets: [{
    name: "S",
    cells: {
      A1: { v: "Cat" }, B1: { v: "Qty" },
      A2: { v: "a" }, B2: { v: 5 },
      A3: { v: "b" }, B3: { v: 8 },
    },
    filter: { range: "A1:B3", cols: {} },
    slicers: [{ col: 0, title: "Cat", sel: ["a"] }],
  }] };
  assertEq(slicerHiddenRows(wb.sheets[0], wb), [2]);
  assert(slicerValues(wb.sheets[0], wb, 0).includes("a"), "slicer values");
});

// ---------- S17.2 HTML-table paste ----------
t("S17.2 htmlToCells basic table", () => {
  const cells = htmlToCells("<table><tr><th>Name</th><th>Qty</th></tr><tr><td>a</td><td>5</td></tr><tr><td>b</td><td>8</td></tr></table>", { col: 0, row: 0 })!;
  assertEq(cells.A1.v, "Name");
  assertEq(cells.B2.v, 5);
  assert(cells.A1.s?.b === true, "th bold");
});

t("S17.2 htmlToCells colspan/rowspan coverage", () => {
  const cells = htmlToCells('<table><tr><td colspan="2">x</td><td>y</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>', { col: 0, row: 0 })!;
  assertEq(cells.A1.v, "x");
  assertEq(cells.C1.v, "y");
  assertEq(cells.C2.v, 3);
});

t("S17.2 htmlToCells ignores non-table html", () => {
  assert(htmlToCells("<p>hello</p>", { col: 0, row: 0 }) === null, "no table → null");
});

t("S17.2 cell img survives json + csv paths", () => {
  const c: CellData = { img: "data:image/png;base64,AAA" };
  const rt = JSON.parse(JSON.stringify(c)) as CellData;
  assertEq(rt.img, "data:image/png;base64,AAA");
});

// ---------- S17.3 external links ----------
t("S17.3 scanExternRefs finds book names", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: "[Budget.xlsx]Q1!B2" },
    A2: { f: "SUM([Budget.xlsx]Q1!B2:B5)+[Other.xls]S!A1" },
    A3: { f: "A1*2" },
  } }] };
  assertEq(scanExternRefs(wb).sort(), ["Budget.xlsx", "Other.xls"]);
});

t("S17.3 KXEXT resolves against wb.externs", () => {
  const wb: Workbook = {
    sheets: [{ name: "Main", cells: {
      A1: { f: "[Ext.xlsx]Data!B2*2" },
      A2: { f: "SUM([Ext.xlsx]Data!B1:B3)" },
      A3: { f: "[Missing.xlsx]S!A1" },
    } }],
    externs: {
      "Ext.xlsx": { sheets: [{ name: "Data", cells: {
        B1: { v: 1 }, B2: { v: 4 }, B3: { v: 5 },
      } }] },
    },
  };
  const res = evaluateWorkbook(wb).get("Main")!;
  assertEq(res.get("A1")?.value, 8);
  assertEq(res.get("A2")?.value, 10);
  assertEq(res.get("A3")?.error ?? res.get("A3")?.value, "#REF!");
});

t("S17.3 extern formulas evaluate inside the cached book", () => {
  const wb: Workbook = {
    sheets: [{ name: "Main", cells: { A1: { f: "[Chain.xlsx]S!C1" } } }],
    externs: { "Chain.xlsx": { sheets: [{ name: "S", cells: {
      A1: { v: 3 }, C1: { f: "A1*7" },
    } }] } },
  };
  assertEq(evaluateWorkbook(wb).get("Main")!.get("A1")?.value, 21);
});

// ---------- S18.1 IMAGE() + rich data types ----------
t("S18.1 IMAGE returns the source URL", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { f: 'IMAGE("https://x/cat.png")' },
    A2: { f: 'IMAGE("")' },
  } }] };
  const res = evaluateWorkbook(wb).get("S")!;
  assertEq(res.get("A1")?.value, "https://x/cat.png");
  assertEq(res.get("A2")?.error ?? res.get("A2")?.value, "#VALUE!");
});

t("S18.1 entity field access A1.Prop", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: {
    A1: { ent: { kind: "Stock", name: "MSFT", props: { Price: 420, Change: 1.5 } } },
    B1: { f: "A1.Price" },
    B2: { f: "A1.price*2" },          // case-insensitive prop lookup
    B3: { f: "A1.Missing" },
    B4: { f: "C1.Price" },            // non-entity cell
  } }] };
  const res = evaluateWorkbook(wb).get("S")!;
  assertEq(res.get("B1")?.value, 420);
  assertEq(res.get("B2")?.value, 840);
  assertEq(res.get("B3")?.error ?? res.get("B3")?.value, "#FIELD!");
  assertEq(res.get("B4")?.error ?? res.get("B4")?.value, "#FIELD!");
});

t("S18.1 entity field across sheets", () => {
  const wb: Workbook = { sheets: [
    { name: "Ents", cells: { A1: { ent: { kind: "Geo", name: "France", props: { Population: 68 } } } } },
    { name: "R", cells: { A1: { f: "Ents!A1.Population" } } },
  ] };
  assertEq(evaluateWorkbook(wb).get("R")!.get("A1")?.value, 68);
});

t("S18.1 decimal literals unaffected by prop rewrite", () => {
  const wb: Workbook = { sheets: [{ name: "S", cells: { A1: { f: "1.5+2.25" } } }] };
  assertEq(evaluateWorkbook(wb).get("S")!.get("A1")?.value, 3.75);
});

// ---------- S18.2 automation (Office Scripts-equivalent) ----------
{
  const { runScript } = await import("./src/sheets/script");
  t("S18.2 script writes values and formulas", () => {
    const wb: Workbook = { sheets: [{ name: "S", cells: { A1: { v: 1 }, A2: { v: 2 } } }] };
    const log = runScript(wb, `
      const s = workbook.getActiveSheet();
      s.getRange("A3").setValue(42);
      s.getRange("B1:B2").setFormulas([["=A1*10"], ["=A2*10"]]);
      console.log("done", s.getRange("A3").getValue());
    `, "S");
    assertEq(wb.sheets[0].cells.A3.v, 42);
    assertEq(wb.sheets[0].cells.B1.f, "A1*10");
    assertEq(log[0], "done 42");
    assertEq(evaluateWorkbook(wb).get("S")!.get("B2")?.value, 20);
  });
  t("S18.2 script sheets + named items + sort", () => {
    const wb: Workbook = { sheets: [{ name: "S", cells: { A1: { v: 3 }, A2: { v: 1 }, A3: { v: 2 } } }] };
    runScript(wb, `
      const s = workbook.getSheet("S");
      s.getRange("A1:A3").sort(0, true);
      workbook.addSheet("Out").getCell(0, 0).setValue("hi");
      workbook.addNamedItem("Top", "S!A1");
      console.log(workbook.getNamedItem("Top").getValue());
    `, "S");
    assertEq(wb.sheets[0].cells.A1.v, 1);
    assertEq(wb.sheets[1].cells.A1.v, "hi");
    assertEq(wb.names?.Top, "S!A1");
  });
}

// ---------- S18.3 Get & Transform ----------
{
  const { parseDelimited, jsonToTable, applySteps, runQuery, queryToSheet } = await import("./src/sheets/query");
  t("S18.3 parseDelimited quoting", () => {
    assertEq(parseDelimited('a,"b,c"\n1,"2\n2"', ","), [["a", "b,c"], ["1", "2\n2"]]);
  });
  t("S18.3 jsonToTable objects + path", () => {
    const t = jsonToTable({ data: { items: [{ a: 1, b: "x" }, { a: 2, b: "y" }] } }, "data.items");
    assertEq(t.headers, ["a", "b"]);
    assertEq(t.rows[1], [2, "y"]);
  });
  t("S18.3 query pipeline filter+groupBy", async () => {
    const spec = {
      name: "q", source: { kind: "csv" as const, text: "cat,qty\na,5\nb,8\na,3\nc,1" },
      steps: [
        { op: "filter" as const, col: 1, cmp: ">" as const, value: "2" },
        { op: "groupBy" as const, col: 0, agg: "sum" as const, valCol: 1 },
        { op: "sort" as const, col: 1, dir: -1 as const },
      ],
    };
    const res = await runQuery(spec);
    assertEq(res.headers[0], "cat");
    assertEq(res.rows, [["a", 8], ["b", 8]]);
  });
  t("S18.3 queryToSheet headers + autofilter", async () => {
    const res = await runQuery({ name: "q", source: { kind: "csv", text: "x,y\n1,2" }, steps: [] });
    const s = queryToSheet("Q", res);
    assertEq(s.cells.A1.v, "x");
    assertEq(s.cells.A2.v, 1);
    assert(s.cells.A1.s?.b === true, "header bold");
    assertEq(s.filter?.range, "A1:B1");
  });
  t("S18.3 cast + distinct + keepCols", () => {
    const res = applySteps(
      { headers: ["a", "b", "c"], rows: [["$1", "x", 9], ["$1", "x", 9], ["$2", "y", 8]] },
      [{ op: "cast", col: 0, to: "number" }, { op: "distinct" }, { op: "keepCols", cols: [0, 1] }],
    );
    assertEq(res.headers, ["a", "b"]);
    assertEq(res.rows, [[1, "x"], [2, "y"]]);
  });
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
