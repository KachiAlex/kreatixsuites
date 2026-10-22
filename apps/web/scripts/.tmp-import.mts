import { readFileSync } from "node:fs";
import { xlsxToWorkbook } from "../src/sheets/io";
import { formatValue } from "../src/sheets/format";
const buf = readFileSync("C:/tmp_test/retirement.xlsx");
const file = new File([buf], "retirement.xlsx");
const wb = await xlsxToWorkbook(file);
for (const sh of wb.sheets) {
  console.log("sheet:", sh.name);
  for (const [ref, c] of Object.entries(sh.cells)) {
    console.log(ref, JSON.stringify({ v: c.v, fmt: c.s?.fmt, s: c.s }), "→", formatValue(c.v, c.s?.fmt));
  }
}
