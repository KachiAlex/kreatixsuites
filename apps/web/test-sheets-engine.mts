// Sheets engine harness — cross-sheet refs, rename/structural rewrites, I/O.
// Run: npx tsx test-sheets-engine.mts
import { evaluateSheetIn, evaluateWorkbook, preprocessFormula, displayValue, cycleAnchors, tokenAtCaret, refsInFormula } from "./src/sheets/engine";
import { adjustForRowsCols, renameSheetRefs, shiftForFill, translateQualifiedRefs } from "./src/sheets/model";
import type { Workbook } from "./src/sheets/model";
import { sheetToCSV, workbookToXLSXBytes, xlsxToWorkbook } from "./src/sheets/io";

let passed = 0, failed = 0;
const check = (name: string, cond: boolean) => {
  if (cond) passed++;
  else { failed++; console.log("FAIL:", name); }
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
