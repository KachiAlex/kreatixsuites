// Perf budget gate — run after `vite build` (node scripts/perf-budget.mjs).
// Asserts the initial-load path stays lean: entry JS/CSS + index.html are what
// the landing/login routes pay on first paint; lazy chunks (editors, pdf.js,
// xlsx) are deferred by route and excluded. Exits non-zero on regression.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const dist = new URL("../dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const indexHtml = readFileSync(join(dist, "index.html"), "utf8");

// entry assets = files referenced directly by index.html (script/link tags)
const entryRefs = [...indexHtml.matchAll(/(?:src|href)="\/(assets\/[^"?#]+)/g)].map((m) => m[1]);
const assetDir = join(dist, "assets");
const all = readdirSync(assetDir).filter((f) => f.endsWith(".js") || f.endsWith(".css"));

const gz = (f) => gzipSync(readFileSync(join(assetDir, f))).length;
const KB = 1024;

let entryBytes = 0;
const entryList = [];
for (const f of all) {
  if (entryRefs.some((r) => r.endsWith("/" + f) || r === "assets/" + f)) {
    const g = gz(f);
    entryBytes += g;
    entryList.push(`${f} ${(g / KB).toFixed(1)}KB gz`);
  }
}
const swSize = statSync(join(dist, "sw.js")).size;

// budgets (gzip'd): entry JS+CSS landed at ~180KB after route splitting; 400KB
// leaves headroom without allowing silent doubling.
const ENTRY_BUDGET = 400 * KB;
let fail = false;
console.log(`entry assets (gzipped): ${(entryBytes / KB).toFixed(1)}KB / ${ENTRY_BUDGET / KB}KB budget`);
for (const l of entryList) console.log("  " + l);
if (entryBytes > ENTRY_BUDGET) {
  console.error(`FAIL: entry bundle exceeds ${ENTRY_BUDGET / KB}KB gzip budget`);
  fail = true;
}

// any single lazy chunk over 1.5MB gz is suspicious
for (const f of all) {
  const g = gz(f);
  if (g > 1500 * KB) {
    console.error(`FAIL: ${f} is ${(g / KB).toFixed(0)}KB gz (>1500KB)`);
    fail = true;
  }
}
if (swSize > 512 * KB) {
  console.error(`FAIL: sw.js is ${(swSize / KB).toFixed(0)}KB (>512KB)`);
  fail = true;
}
console.log(fail ? "perf budget FAILED" : "perf budget OK");
process.exit(fail ? 1 : 0);
