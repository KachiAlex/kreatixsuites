// Probe: Writer spellcheck against the built app.
// Verifies the hunspell dictionary clears false positives, real typos get
// squiggles, and accepting a suggestion clears the underline.
// Usage: npx tsx scripts/spellcheck-probe.mts http://127.0.0.1:5444
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

// 1. Home has an Open-document action
const hasOpen = await page.evaluate(() =>
  [...document.querySelectorAll("button")].some((b) => /open\s+(a\s+)?document|open.*computer/i.test(b.textContent ?? "")));
console.log("home open-document button:", hasOpen);

// 2. Create a Writer doc
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("button")] as HTMLElement[];
  btns.find((b) => /create a file/i.test(b.textContent ?? ""))?.click();
});
await page.waitForSelector(".ProseMirror", { timeout: 20000 });
await new Promise((r) => setTimeout(r, 300));

// 3. Type words the old dictionary wrongly flagged + one real typo
await page.click(".ProseMirror");
await page.keyboard.type(
  "A phased plan for platform development, streaming infrastructure and stakeholder ownership. teh resilience",
  { delay: 5 });
await new Promise((r) => setTimeout(r, 2500)); // let the dictionary load + recompute

const flagged1 = await page.evaluate(() =>
  [...document.querySelectorAll(".kx-spell")].map((e) => e.textContent));
console.log("flagged after typing:", JSON.stringify(flagged1));

// 4. Right-click the typo → context menu → accept suggestion
const squiggle = await page.$(".kx-spell");
if (squiggle) {
  const box = await squiggle.boundingBox();
  await page.mouse.click(box.x + 3, box.y + 3, { button: "right" });
  await new Promise((r) => setTimeout(r, 400));
  const menuItems = await page.evaluate(() =>
    [...document.querySelectorAll(".ctx-menu button, .context-menu button, .menu-item")].map((b) => b.textContent?.trim()));
  console.log("context menu items:", JSON.stringify(menuItems?.slice(0, 8)));
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")] as HTMLElement[];
    btns.find((b) => b.textContent?.trim() === "the")?.click();
  });
  await new Promise((r) => setTimeout(r, 800));
}
const flagged2 = await page.evaluate(() =>
  [...document.querySelectorAll(".kx-spell")].map((e) => e.textContent));
const text = await page.evaluate(() => document.querySelector(".ProseMirror")?.textContent);
console.log("flagged after accept:", JSON.stringify(flagged2));
console.log("doc text tail:", text?.slice(-40));

await browser.close();
