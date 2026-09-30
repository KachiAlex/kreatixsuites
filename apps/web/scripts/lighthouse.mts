// Lighthouse CI — serves dist via `vite preview`, audits key routes with
// headless Chrome, enforces score + Core-Web-Vitals budgets. Exit 1 on fail.
//   pnpm build && node --import tsx scripts/lighthouse.mts
// Env: LH_URLS="http://localhost:PORT/,..." to override targets.
import { spawn } from "node:child_process";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";

const PORT = 4173;
const BASE = `http://localhost:${PORT}`;

// budgets per route — the landing page is the SEO-critical one
const TARGETS = [
  { url: `${BASE}/`, name: "landing", minPerf: 0.85, minSeo: 0.9, lcpMs: 4000, tbtMs: 600 },
  { url: `${BASE}/login`, name: "login", minPerf: 0.8, minSeo: 0.9, lcpMs: 4500, tbtMs: 800 },
];

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const preview = spawn(pnpmBin, ["preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500)); // wait for preview to bind

let chrome;
let failed = false;
try {
  chrome = await chromeLauncher.launch({ chromeFlags: ["--headless", "--no-sandbox", "--disable-gpu"] });
  for (const t of TARGETS) {
    const res = await lighthouse(t.url, { port: chrome.port, output: "json", logLevel: "error" });
    if (!res) { console.error(`${t.name}: lighthouse returned no result`); failed = true; continue; }
    const { categories, audits } = res.lhr;
    const perf = categories.performance?.score ?? 0;
    const seo = categories.seo?.score ?? 0;
    const a11y = categories.accessibility?.score ?? 0;
    const lcp = audits["largest-contentful-paint"]?.numericValue ?? Infinity;
    const tbt = audits["total-blocking-time"]?.numericValue ?? Infinity;
    const cls = audits["cumulative-layout-shift"]?.numericValue ?? 0;
    console.log(`${t.name}: perf=${(perf * 100).toFixed(0)} seo=${(seo * 100).toFixed(0)} a11y=${(a11y * 100).toFixed(0)} LCP=${lcp.toFixed(0)}ms TBT=${tbt.toFixed(0)}ms CLS=${cls.toFixed(3)}`);
    if (perf < t.minPerf) { console.error(`  FAIL perf ${(perf * 100).toFixed(0)} < ${t.minPerf * 100}`); failed = true; }
    if (seo < t.minSeo) { console.error(`  FAIL seo ${(seo * 100).toFixed(0)} < ${t.minSeo * 100}`); failed = true; }
    if (lcp > t.lcpMs) { console.error(`  FAIL LCP ${lcp.toFixed(0)}ms > ${t.lcpMs}ms`); failed = true; }
    if (tbt > t.tbtMs) { console.error(`  FAIL TBT ${tbt.toFixed(0)}ms > ${t.tbtMs}ms`); failed = true; }
  }
} finally {
  try { chrome?.kill(); } catch { /* already dead */ }
  preview.kill();
}
console.log(failed ? "lighthouse FAILED" : "lighthouse OK");
process.exit(failed ? 1 : 0);
