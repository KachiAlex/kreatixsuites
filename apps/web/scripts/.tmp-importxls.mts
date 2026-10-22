import { readFileSync } from "node:fs";
import { xlsxToWorkbook } from "../src/sheets/io";
import { formatValue } from "../src/sheets/format";
const buf = readFileSync("C:/tmp_test/retirement.xls");
const wb = await xlsxToWorkbook(new File([buf], "retirement.xls"));
for (const sh of wb.sheets)
  for (const [ref, c] of Object.entries(sh.cells))
    console.log(ref, JSON.stringify({ v: c.v, s: c.s }), "→", formatValue(c.v, c.s?.fmt));
