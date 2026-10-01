// Probe: ribbon group dropdowns + submenu flyouts + ruler attachment.
// Usage: npx tsx scripts/submenu-probe.mts http://127.0.0.1:5444
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:5444";
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p)) ?? "chrome";

const browser = await puppeteer.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 300)));
await page.setViewport({ width: 1200, height: 700 });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("kx.anon", "1");
  localStorage.setItem("kx.installAt", String(Date.now()));
});
await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 2000));
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")] as HTMLElement[];
  btns.find((b) => /create a file/i.test(b.textContent ?? ""))?.click();
});
await page.waitForSelector(".ProseMirror", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 500));

// ruler sits flush under the ribbon
const geom = await page.evaluate(() => {
  const wrap = document.querySelector(".ribbon-wrap")?.getBoundingClientRect();
  const ruler = document.querySelector(".ruler-wrap")?.getBoundingClientRect();
  return { ribbonBottom: wrap?.bottom, rulerTop: ruler?.top, gap: (ruler?.top ?? -1) - (wrap?.bottom ?? -1) };
});
console.log("ruler gap under ribbon:", JSON.stringify(geom));

// open the Insert menu-tab dropdown (Edit/View/Insert/Format… are menu tabs)
await page.evaluate(() => {
  const tabs = [...document.querySelectorAll(".ribbon-tab")] as HTMLElement[];
  const menuTabs = tabs.filter((t) => t.classList.contains("menu-tab"));
  menuTabs.find((t) => t.textContent?.includes("Insert"))?.click();
});
await new Promise((r) => setTimeout(r, 400));
console.log("open drops:", await page.evaluate(() => document.querySelectorAll(".menu-drop").length),
  "items:", await page.evaluate(() =>
    [...document.querySelectorAll(".menu-drop .menu-item")].map((e) => e.textContent?.trim()).join(" | ")));

// hover the "Image" item → submenu flyout should appear, position:fixed, visible
const box = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".menu-drop .menu-item")].find((e) => e.textContent?.trim().startsWith("Image"));
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x + 30, y: r.y + r.height / 2 };
});
if (!box) { console.log("FAIL: Image item not found"); await browser.close(); process.exit(1); }
await page.mouse.move(box.x, box.y);
await new Promise((r) => setTimeout(r, 400));

const sub = await page.evaluate(() => {
  const s = document.querySelector(".menu-drop.sub") as HTMLElement | null;
  if (!s) return null;
  const r = s.getBoundingClientRect();
  const cs = getComputedStyle(s);
  return { pos: cs.position, left: r.left, top: r.top, w: r.width, visible: r.width > 0 && r.height > 0,
    items: [...s.querySelectorAll(".menu-item")].map((b) => b.textContent?.trim()) };
});
console.log("submenu:", JSON.stringify(sub));

// hover a second-level submenu inside it (Table ▸ Quick tables has depth 2 via Insert ▸ Table)
await page.evaluate(() => {
  const items = [...document.querySelectorAll(".menu-drop:not(.sub) .menu-item")] as HTMLElement[];
  items.find((el) => el.textContent?.trim().startsWith("Table"))?.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
});
await new Promise((r) => setTimeout(r, 300));
const nested = await page.evaluate(() => document.querySelectorAll(".menu-drop.sub").length);
console.log("open submenu flyouts:", nested);

await page.screenshot({ path: "submenu-probe.png" });
await browser.close();
