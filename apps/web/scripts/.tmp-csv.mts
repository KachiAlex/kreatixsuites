import { readFileSync } from "node:fs";
import { csvToSheet } from "../src/sheets/io";
import { formatValue } from "../src/sheets/format";
const text = readFileSync("C:/Users/opdli/Downloads/IT Expense Retirement(Sheet1).csv", "utf-8");
const sh = csvToSheet("Retirement", text);
for (const [ref, c] of Object.entries(sh.cells).sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true })))
  console.log(ref, "→", formatValue(c.v, c.s?.fmt), c.f ? `(f:${c.f})` : "");
