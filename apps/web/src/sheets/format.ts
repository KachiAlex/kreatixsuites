// Number format presets (KBS-SHEETS-005)
export const NUM_FORMATS = [
  { id: "auto", label: "Automatic" },
  { id: "0", label: "Integer (0)" },
  { id: "0.00", label: "Number (0.00)" },
  { id: "#,##0.00", label: "Thousands (1,234.56)" },
  { id: "0%", label: "Percent (0%)" },
  { id: "0.00%", label: "Percent (0.00%)" },
  { id: "$#,##0.00", label: "Currency ($1,234.56)" },
  { id: "₦#,##0.00", label: "Naira (₦1,234.56)" },
  { id: "yyyy-mm-dd", label: "Date (2026-09-26)" },
];

function group(n: string): string {
  const [i, d] = n.split(".");
  const sign = i.startsWith("-") ? "-" : "";
  const digits = sign ? i.slice(1) : i;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (d !== undefined ? "." + d : "");
}

export function formatValue(v: unknown, fmt: string | undefined): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (!fmt || fmt === "auto") return String(v);

  if (fmt === "yyyy-mm-dd") {
    const d = typeof v === "number"
      ? new Date(Date.UTC(1899, 11, 30) + v * 86400000) // Excel serial
      : new Date(String(v));
    return isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
  }

  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (isNaN(n)) return String(v);

  switch (fmt) {
    case "0": return String(Math.round(n));
    case "0.00": return n.toFixed(2);
    case "#,##0.00": return group(n.toFixed(2));
    case "0%": return `${Math.round(n * 100)}%`;
    case "0.00%": return `${(n * 100).toFixed(2)}%`;
    case "$#,##0.00": return `$${group(n.toFixed(2))}`;
    case "₦#,##0.00": return `₦${group(n.toFixed(2))}`;
    default: return String(v);
  }
}
