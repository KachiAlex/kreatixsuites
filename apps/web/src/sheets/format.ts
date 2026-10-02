// Number formats â presets + a subset of Excel custom format codes (S4.5)
export const NUM_FORMATS = [
  { id: "auto", label: "Automatic" },
  { id: "0", label: "Integer (0)" },
  { id: "0.00", label: "Number (0.00)" },
  { id: "#,##0", label: "Thousands (1,235)" },
  { id: "#,##0.00", label: "Thousands (1,234.56)" },
  { id: "0%", label: "Percent (0%)" },
  { id: "0.00%", label: "Percent (0.00%)" },
  { id: "$#,##0.00", label: "Currency ($1,234.56)" },
  { id: '"$"#,##0.00_);("$"#,##0.00)', label: "Accounting ($1,234.56)" },
  { id: "â¦#,##0.00", label: "Naira (â¦1,234.56)" },
  { id: "0.00E+00", label: "Scientific (1.23E+04)" },
  { id: "# ?/?", label: "Fraction (1 1/4)" },
  { id: "@", label: "Text" },
  { id: "yyyy-mm-dd", label: "Date (2026-09-26)" },
  { id: "dd/mm/yyyy", label: "Date (26/09/2026)" },
  { id: "mmm d, yyyy", label: "Date (Sep 26, 2026)" },
  { id: "h:mm AM/PM", label: "Time (2:30 PM)" },
];

export const isFormatCode = (fmt?: string) => !!fmt && fmt !== "auto";

// ---------- locale awareness ----------

/** Common Windows LCIDs (hex, as written in `[$-409]` tags) → BCP-47. */
const LCID_LOCALE: Record<string, string> = {
  "401": "ar-SA", "405": "cs-CZ", "406": "da-DK", "407": "de-DE", "807": "de-CH",
  "408": "el-GR", "409": "en-US", "809": "en-GB", "1009": "en-CA", "c09": "en-AU",
  "40a": "es-ES", "c0a": "es-ES", "80a": "es-MX", "40b": "fi-FI", "40c": "fr-FR",
  "80c": "fr-BE", "c0c": "fr-CA", "410": "it-IT", "411": "ja-JP", "412": "ko-KR",
  "413": "nl-NL", "813": "nl-BE", "414": "nb-NO", "415": "pl-PL", "416": "pt-BR",
  "816": "pt-PT", "419": "ru-RU", "41d": "sv-SE", "41e": "th-TH", "41f": "tr-TR",
  "422": "uk-UA", "42a": "vi-VN", "439": "hi-IN", "45a": "ur-PK", "804": "zh-CN",
  "404": "zh-TW", "40d": "he-IL", "421": "id-ID", "43f": "kk-KZ", "425": "et-EE",
};

/** `[$-409]` / `[$-fr-FR]` / `[$€-407]` locale tags → BCP-47 tag or undefined. */
function tagLocale(code: string): string | undefined {
  const m = /\[\$[^\]-]*-([0-9a-fA-F]{3,4}|[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]+)*)\]/.exec(code);
  if (!m) return undefined;
  const t = m[1];
  if (/^[0-9a-fA-F]+$/.test(t)) return LCID_LOCALE[t.toLowerCase()];
  try { return Intl.NumberFormat.supportedLocalesOf([t]).length ? t : undefined; }
  catch { return undefined; }
}

interface Seps { grp: string; dec: string }
const sepCache = new Map<string, Seps>();
function localeSeps(loc: string | undefined): Seps {
  const key = loc ?? "en-US";
  let s = sepCache.get(key);
  if (!s) {
    try {
      const p = new Intl.NumberFormat(key).formatToParts(12345.6);
      s = { grp: p.find((x) => x.type === "group")?.value ?? ",", dec: p.find((x) => x.type === "decimal")?.value ?? "." };
    } catch { s = { grp: ",", dec: "." }; }
    sepCache.set(key, s);
  }
  return s;
}

const monthCache = new Map<string, string[]>();
function monthNames(loc: string | undefined, long: boolean): string[] {
  const key = `${loc ?? "en-US"}|${long}`;
  let a = monthCache.get(key);
  if (!a) {
    try {
      const f = new Intl.DateTimeFormat(loc ?? "en-US", { month: long ? "long" : "short", timeZone: "UTC" });
      a = Array.from({ length: 12 }, (_, i) => f.format(new Date(Date.UTC(2000, i, 1))));
    } catch { a = long ? MONTHS_FULL : MONTHS_ABBR; }
    monthCache.set(key, a);
  }
  return a;
}

const dayCache = new Map<string, string[]>();
function dayNames(loc: string | undefined, long: boolean): string[] {
  const key = `${loc ?? "en-US"}|${long}`;
  let a = dayCache.get(key);
  if (!a) {
    try {
      const f = new Intl.DateTimeFormat(loc ?? "en-US", { weekday: long ? "long" : "short", timeZone: "UTC" });
      // Jan 2 2000 = Sunday
      a = Array.from({ length: 7 }, (_, i) => f.format(new Date(Date.UTC(2000, 0, 2 + i))));
    } catch { a = long ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]; }
    dayCache.set(key, a);
  }
  return a;
}

/** translate US-canonical separators in a formatted number to `loc` conventions */
function localizeDigits(s: string, loc: string | undefined): string {
  if (!loc || /^en-us$/i.test(loc)) return s;
  const { grp, dec } = localeSeps(loc);
  if (grp === "," && dec === ".") return s;
  return s.replace(/,/g, String.fromCharCode(0xE000)).replace(/\./g, dec).replace(new RegExp(String.fromCharCode(0xE000), "g"), grp);
}

function group(n: string): string {
  const [i, d] = n.split(".");
  const sign = i.startsWith("-") ? "-" : "";
  const digits = sign ? i.slice(1) : i;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return sign + grouped + (d !== undefined ? "." + d : "");
}

// ---------- custom format-code engine ----------

/** Split a format code into `pos;neg;zero;text` sections, respecting
 *  "â¦" literals and [â¦] conditions/colors. */
function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') {
      const j = code.indexOf('"', i + 1);
      cur += code.slice(i, j < 0 ? code.length : j + 1);
      i = j < 0 ? code.length : j;
      continue;
    }
    if (ch === "[") { depth++; cur += ch; continue; }
    if (ch === "]") { depth--; cur += ch; continue; }
    if (ch === ";" && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Strip control tokens: _x spacer, *x fill, [Color]/[cond], \x escape.
 *  Quoted "â¦" literals keep their text. */
function cleanSection(sec: string): string {
  return sec
    .replace(/\[\$([^\]-]*)-[^\]]*\]/g, "$1") // [$€-407] keeps "€", drops tag
    .replace(/\[[^\]]*\]/g, "")
    .replace(/_./g, " ")
    .replace(/\*./g, "")
    .replace(/\\(.)/g, "$1")
    .replace(/"([^"]*)"/g, "$1");
}

const MONTHS_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function dateFromValue(v: unknown): Date | null {
  if (typeof v === "number") {
    const d = new Date(Date.UTC(1899, 11, 30) + v * 86400000); // Excel serial
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(sec: string, d: Date, loc?: string): string {
  const hh = d.getUTCHours(), mi = d.getUTCMinutes(), ss = d.getUTCSeconds();
  const ampm = /am\/pm|a\/p/i.test(sec);
  const H = ampm ? ((hh + 11) % 12) + 1 : hh;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const mAbbr = monthNames(loc, false), mFull = monthNames(loc, true);
  const dAbbr = dayNames(loc, false), dFull = dayNames(loc, true);
  const dow = d.getUTCDay();
  // single-pass: quoted literals, control tokens, and date tokens are consumed inline
  const re = /"([^"]*)"|\[[^\]]*\]|\\.|_.|\*.|yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|ss|s|am\/pm|a\/p|./gis;
  const bits: string[] = [];
  let m: RegExpExecArray | null;
  let prevTok = "";
  while ((m = re.exec(sec))) {
    const tok = m[0];
    const c0 = tok[0];
    if (c0 === '"') { bits.push(m[1]); prevTok = "lit"; continue; }
    if (c0 === "[") { const cur = /^\[\$([^\]-]*)-/.exec(tok); if (cur?.[1]) bits.push(cur[1]); continue; } // [$€-407] keeps "€"
    if (c0 === "*") continue;                             // *fill
    if (c0 === "\\") { bits.push(tok[1]); prevTok = "lit"; continue; } // \x escape
    if (c0 === "_") { bits.push(" "); prevTok = "lit"; continue; }  // _x spacer
    const l = tok.toLowerCase();
    if (!/^[ymdhsa]/i.test(l)) { bits.push(tok); continue; } // separator/punct — keep prevTok
    switch (l) {
      case "yyyy": bits.push(String(d.getUTCFullYear())); break;
      case "yy": bits.push(String(d.getUTCFullYear()).slice(2)); break;
      case "mmmm": bits.push(mFull[d.getUTCMonth()]); break;
      case "mmm": bits.push(mAbbr[d.getUTCMonth()]); break;
      case "dddd": bits.push(dFull[dow]); break;
      case "ddd": bits.push(dAbbr[dow]); break;
      case "dd": bits.push(p2(d.getUTCDate())); break;
      case "d": bits.push(String(d.getUTCDate())); break;
      case "hh": bits.push(p2(H)); break;
      case "h": bits.push(String(H)); break;
      case "ss": bits.push(p2(ss)); break;
      case "s": bits.push(String(ss)); break;
      case "am/pm": case "a/p": bits.push(hh < 12 ? "AM" : "PM"); break;
      case "mm": case "m": {
        const after = sec.slice(m.index + tok.length);
        const isMin = /^[hs]$/.test(prevTok) || /^[:;.\s]*s/i.test(after);
        const v = isMin ? mi : d.getUTCMonth() + 1;
        bits.push(l === "mm" ? p2(v) : String(v));
        break;
      }
      default: bits.push(tok);
    }
    prevTok = l;
  }
  return bits.join("");
}

function toFraction(n: number, maxDenom: number): string {
  const whole = Math.floor(Math.abs(n));
  const frac = Math.abs(n) - whole;
  if (frac < 1e-9) return String(n);
  let bNum = 0, bDen = 1, err = frac;
  for (let dd = 1; dd <= maxDenom; dd++) {
    const nn = Math.round(frac * dd);
    const e = Math.abs(frac - nn / dd);
    if (e < err - 1e-9) { err = e; bNum = nn; bDen = dd; }
  }
  const sign = n < 0 ? "-" : "";
  const fr = bNum === 0 ? "" : `${bNum}/${bDen}`;
  return whole === 0 ? sign + (fr || "0") : sign + whole + (fr ? ` ${fr}` : "");
}

function formatNumber(n: number, sec: string, loc?: string): string {
  const c = cleanSection(sec);
  const pct = c.includes("%");
  if (pct) n = n * 100;
  // scientific: 0.00E+00
  const sci = c.match(/([0#?]+)\.([0#?]+)\s*E([+-])([0#?]+)/i);
  if (sci) {
    const dec = sci[2].length;
    const s = n.toExponential(dec);
    const m = s.match(/^([+-]?\d+\.?\d*)e([+-])(\d+)$/i);
    if (!m) return s;
    const exp = String(Math.abs(Number(m[3]))).padStart(sci[4].length, "0");
    const mant = localizeDigits(c.includes(",") ? group(m[1]) : m[1], loc);
    return `${mant}E${sci[3]}${exp}`;
  }
  // fraction: # ?/? or ??/?? â max denominator from ? count
  const fr = c.match(/([0#?]*)\s*(\?+)\/(\?+)/);
  if (fr) {
    const maxD = Math.min(Math.pow(10, fr[3].length) - 1, 999);
    return toFraction(n, maxD);
  }
  // decimal pattern: placeholders around '.', optional thousands ','
  const numMatch = c.match(/[0#?,]+(?:\.[0#?]+)?/) ?? [""];
  const raw = String(numMatch[0]);
  if (!/[0#?]/.test(raw)) return String(n);
  const [intP = "", decP = ""] = raw.split(".");
  const decs = decP.length;
  const thousands = intP.includes(",");
  let abs = Math.abs(n).toFixed(decs);
  if (thousands) abs = group(abs);
  const reqInt = (intP.replace(/,/g, "").match(/0/g) ?? []).length;
  const [i, dd] = abs.split(".");
  const sign = n < 0 ? "-" : "";
  const int = reqInt && i.length < reqInt ? "0".repeat(reqInt - i.length) + i : i;
  abs = int + (dd !== undefined && decs > 0 ? "." + dd : "");
  // literal text around the number pattern becomes prefix/suffix
  const idx = c.indexOf(raw);
  const pre = c.slice(0, idx).replace(/%/g, "");
  const suf = c.slice(idx + raw.length);
  return `${sign}${pre}${localizeDigits(abs, loc)}${suf}`;
}

/** Apply a (possibly multi-section) format code to a value.
 *  `locale` is a BCP-47 tag controlling separators + month/day names;
 *  a `[$-xxxx]` tag inside the code overrides it (Excel convention). */
export function formatCode(v: unknown, code: string, locale?: string): string {
  const loc = tagLocale(code) ?? locale;
  const secs = splitSections(code);
  const isDateCode = (s: string) => {
    const probe = cleanSection(s).replace(/am\/pm|a\/p/ig, "");
    return (/[ydhs]/i.test(probe) || /m/i.test(probe)) && !/[0#?%@]/.test(probe) && !/e[+-]/i.test(probe);
  };
  const isText = typeof v === "string" && isNaN(Number(v));
  // date codes also apply to text that parses as a date ("2024-02-29")
  if (isDateCode(secs[0])) {
    const d = dateFromValue(v);
    if (d) return formatDate(secs[0], d, loc);
  }
  if (isText) {
    const tsec = secs[3] ?? secs[0];
    if (tsec && tsec.includes("@")) return cleanSection(tsec).replace(/@/g, v);
    return v;
  }
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  if (isNaN(n)) return String(v);
  const sec = n > 0 ? secs[0] : n < 0 ? (secs[1] ?? secs[0]) : (secs[2] ?? secs[0]);
  const useN = n < 0 && secs[1] ? Math.abs(n) : n;
  return formatNumber(useN, sec, loc);
}

export function formatValue(v: unknown, fmt: string | undefined, locale?: string): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (!isFormatCode(fmt)) return String(v);
  if (fmt === "@") return String(v);
  return formatCode(v, fmt!, locale);
}
