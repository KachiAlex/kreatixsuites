import { parseInput } from "../src/sheets/model";
import { formatValue } from "../src/sheets/format";
for (const s of ["?41,500.00", "-?1,500.00", "?20,000.00", "N50,000", "₦2,500.00",
                 "20-Sep", "8-Oct", "Transport to Treasury", "Item1", "A12",
                 "41500", "50%", "FLOAT WEEKLY RETIREMENT", "(₦1,500.00)", "$2.50", "1e5"]) {
  const c = parseInput(s);
  console.log(JSON.stringify(s).padEnd(28), "→", JSON.stringify(c), "| display:", formatValue(c.v, c.s?.fmt));
}
