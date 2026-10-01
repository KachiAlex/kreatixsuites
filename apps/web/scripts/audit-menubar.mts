// Focused probe: Writer menubar submenu hover behavior.
import puppeteer from "puppeteer-core";
import { existsSync } from "node:fs";
const BASE = process.argv[2] ?? "http://127.0.0.1:5447";
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p)) ?? "chrome";
const browser = await puppeteer.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", String(e).slice(0, 200)));
await page.setViewport({ width: 1280, height: 760 });
await page.evaluateOnNewDocument(`
  localStorage.setItem("kx.anon", "1");
  localStorage.setItem("kx.installAt", String(Date.now()));
`);
await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
await new Promise((r) => setTimeout(r, 2200));
await page.evaluate(() => {
  const card = [...document.querySelectorAll(".app-card")] as HTMLElement[];
  card.find((c) => (c.textContent ?? "").toLowerCase().includes("writer"))?.click();
});
await page.waitForSelector(".ProseMirror", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 1000));

// does Writer render a classic .menubar?
console.log("menubar btns:", await page.evaluate(() =>
  [...document.querySelectorAll(".menubar .menu-btn")].map((b) => (b.textContent ?? "").trim()).join(" | ")));
console.log("ribbon menu-tabs:", await page.evaluate(() =>
  [...document.querySelectorAll(".ribbon-tab.menu-tab")].map((b) => (b.textContent ?? "").trim()).join(" | ")));

// open Insert menu (whichever host has it) and hover each ▸ item
const openMenu = async (name: string) => {
  await page.evaluate((n) => {
    const all = [...document.querySelectorAll(".ribbon-tab, .menubar .menu-btn")] as HTMLElement[];
    all.find((b) => (b.textContent ?? "").trim().replace(/^[^A-Za-z]+/, "") === n)?.click();
  }, name);
  await new Promise((r) => setTimeout(r, 350));
};

for (const menu of ["Insert", "Format", "Edit"]) {
  await openMenu(menu);
  const subs = await page.evaluate(() =>
    [...document.querySelectorAll(".menu-drop:not(.sub) > .menu-item")]
      .filter((e) => !!e.querySelector(".menu-sub-arrow"))
      .map((e) => (e.querySelector(".menu-label")?.textContent ?? "").trim()));
  console.log(`\n${menu} submenu parents:`, subs.join(" | ") || "(none)");
  for (const s of subs.slice(0, 6)) {
    const box = await page.evaluate((lbl) => {
      const items = [...document.querySelectorAll(".menu-drop:not(.sub) > .menu-item")] as HTMLElement[];
      const it = items.find((e) => (e.querySelector(".menu-label")?.textContent ?? "").trim() === lbl);
      if (!it) return null;
      const r = it.getBoundingClientRect();
      return { x: r.x + 20, y: r.y + r.height / 2 };
    }, s);
    if (!box) continue;
    await page.mouse.move(box.x, box.y + 50);
    await new Promise((r) => setTimeout(r, 80));
    await page.mouse.move(box.x, box.y, { steps: 4 });
    await new Promise((r) => setTimeout(r, 350));
    const open = await page.evaluate(() =>
      [...document.querySelectorAll(".menu-drop.sub")].map((d) => ({
        vis: (d as HTMLElement).offsetParent !== null || (d as HTMLElement).getBoundingClientRect().width > 0,
        items: [...d.children].length,
      })));
    console.log(`  ${menu} ▸ ${s}: sub drops=${JSON.stringify(open)}`);
  }
  // close
  await page.keyboard.press("Escape");
  await new Promise((r) => setTimeout(r, 200));
}
await browser.close();
