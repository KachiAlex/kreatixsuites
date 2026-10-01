import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";
import { existsSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:5199";
const OUT = new URL("../mobile-audit/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT, { recursive: true });
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p)) ?? "chrome";

const browser = await puppeteer.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("[console]", m.text().slice(0, 200)); });
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.setViewport({ width: 1024, height: 620 });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("kx.anon", "1");
  localStorage.setItem("kx.installAt", String(Date.now()));
});
await page.goto(`${BASE}/home`, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 700));

// create a Sheets doc via the create menu
await page.evaluate(() => (document.querySelector(".sidebar .create") as HTMLElement)?.click());
await new Promise((r) => setTimeout(r, 300));
await page.evaluate((label) => {
  const btns = [...document.querySelectorAll(".create-menu button")] as HTMLElement[];
  btns.find((b) => b.textContent?.includes(label))?.click();
}, process.argv[3] ?? "Sheets");
await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 15000 }).catch(() => {});
await page.waitForSelector(".ribbon-tabs", { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 1200));
console.log("url:", page.url(), "ribbon:", !!(await page.$(".ribbon-tabs")));

// click the File ribbon tab
await page.evaluate(() => {
  const tabs = [...document.querySelectorAll(".ribbon-tab")] as HTMLElement[];
  tabs.find((t) => t.classList.contains("menu-tab"))?.click();
});
await new Promise((r) => setTimeout(r, 400));

const drop = await page.evaluate(() => {
  const d = document.querySelector(".ribbon-menu-drop") as HTMLElement | null;
  if (!d) return { found: false } as Record<string, unknown>;
  const r = d.getBoundingClientRect();
  const s = getComputedStyle(d);
  const items = [...d.querySelectorAll(".menu-item, button")].map((b) => b.textContent?.trim());
  return {
    found: true, left: r.left, top: r.top, w: r.width, h: r.height,
    visible: r.width > 50 && r.height > 50 && r.bottom <= window.innerHeight + 2,
    display: s.display, position: s.position, opacity: s.opacity,
    clippedBy: (() => { let n = d.parentElement; const o: string[] = []; while (n) { const st = getComputedStyle(n); if (st.overflow !== "visible" || st.overflowY !== "visible") o.push(n.className + " " + st.overflow); n = n.parentElement; } return o; })(),
    items,
  };
});
console.log(JSON.stringify(drop, null, 1));
await page.screenshot({ path: `${OUT}filemenu.png` });
await browser.close();
