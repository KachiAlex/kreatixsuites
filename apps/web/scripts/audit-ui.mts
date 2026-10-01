/**
 * Runtime UI audit: walk every ribbon tab, dropdown group, menubar menu and
 * button in each editor; classify each click as
 *   error | nav | filepick | download | dialog | mutate | noop
 * Also sweeps every remaining visible <button> in the editor root.
 * Usage: npx tsx scripts/audit-ui.mts http://127.0.0.1:5447
 */
import puppeteer, { type Page } from "puppeteer-core";
import { existsSync, writeFileSync } from "node:fs";

const BASE = process.argv[2] ?? "http://127.0.0.1:5447";
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].find((p) => existsSync(p)) ?? "chrome";

type Row = { label: string; effect: string; note?: string };
const results: Record<string, Row[]> = {};
let errors: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newPage() {
  const browser = await puppeteer.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 760 });
  page.on("pageerror", (e) => errors.push(`[pageerror] ${String(e).slice(0, 220)}`));
  page.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/WebSocket|favicon|net::|Failed to load resource/.test(t))
      errors.push(`[console.error] ${t.slice(0, 220)}`);
  });
  page.on("dialog", (d) => { void d.dismiss(); });
  // raw-string injection — tsx/esbuild wraps function bodies in __name() which
  // doesn't exist in the page, killing everything after the throw
  await page.evaluateOnNewDocument(`
    localStorage.setItem("kx.anon", "1");
    localStorage.setItem("kx.installAt", String(Date.now()));
    window.__fx = { filepick: 0, download: 0, mutations: 0 };
    var ic = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type === "file") window.__fx.filepick++;
      return ic.call(this);
    };
    var ac = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__fx.download++;
      return ac.call(this);
    };
    function installObs() {
      var mo = new MutationObserver(function (ms) { window.__fx.mutations += ms.length; });
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    if (document.documentElement) installObs();
    else document.addEventListener("DOMContentLoaded", installObs, { once: true });
  `);
  return { browser, page };
}

async function classify(page: Page, act: () => Promise<void>) {
  const before = await page.evaluate(() => ({ ...(window as any).__fx, url: location.href }));
  const errBefore = errors.length;
  await act();
  await sleep(400);
  const after = await page.evaluate(() => ({ ...(window as any).__fx, url: location.href }));
  const out: string[] = [];
  if (errors.length > errBefore) out.push("error");
  if (after.url !== before.url) out.push("nav");
  if (after.filepick > before.filepick) out.push("filepick");
  if (after.download > before.download) out.push("download");
  const dlg = await page.evaluate(() => !!document.querySelector(".dlg, [role=dialog]"));
  if (dlg) out.push("dialog");
  if (after.mutations > before.mutations) out.push("mutate");
  return out.length ? out.join("+") : "noop";
}

// ---------- in-page helpers ----------
const HELPERS = `
window.__ui = {
  txt: (e) => (e.textContent ?? "").trim().replace(/\\s+/g, " "),
  labelOf: (e) => (e.querySelector(".menu-label")?.textContent ?? e.textContent ?? "").trim().replace(/\\s+/g, " "),
  rootDrop: () => document.querySelector(".menu-drop:not(.sub)"),
  findDrop: (ancestors) => {
    let drop = window.__ui.rootDrop();
    for (const a of ancestors) {
      if (!drop) return null;
      const item = [...drop.children].find((el) => el.classList?.contains("menu-item") && window.__ui.labelOf(el).replace(/\\s*▸\\s*$/, "") === a);
      if (!item) return null;
      drop = item.querySelector(".menu-drop.sub");
    }
    return drop;
  },
  itemsOf: (drop) => [...drop.children].filter((el) => el.classList?.contains("menu-item")).map((el) => ({
    label: window.__ui.labelOf(el).replace(/\\s*▸\\s*$/, ""),
    disabled: el.classList.contains("disabled") || el.getAttribute("aria-disabled") === "true",
    hasSub: !!el.querySelector(".menu-sub-arrow"),
  })),
  itemAt: (drop, label) => [...drop.children].find((el) => el.classList?.contains("menu-item") && window.__ui.labelOf(el).replace(/\\s*▸\\s*$/, "") === label),
};
`;

interface MenuItemInfo { label: string; disabled: boolean; hasSub: boolean }

/** Re-open the menu from the root opener, then hover each ancestor so the
 *  target depth's drop exists. Returns the item list at `ancestors.length`. */
/** Hover a menu item with a REAL mouse move — React synthesizes onMouseEnter
 *  from mouseover/mouseout, so dispatching raw "mouseenter" does nothing. */
async function hoverItem(page: Page, ancestors: string[], label: string): Promise<boolean> {
  const box = await page.evaluate((ancs, l) => {
    const drop = (window as any).__ui.findDrop(ancs);
    const item = drop && (window as any).__ui.itemAt(drop, l);
    if (!item) return null;
    const r = item.getBoundingClientRect();
    return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 };
  }, ancestors, label);
  if (!box) return false;
  // move off first — if the pointer already rests on this item (menu re-opened
  // under a stationary mouse), mouseover never refires and the submenu stays shut
  await page.mouse.move(box.x, box.y + 60);
  await sleep(60);
  await page.mouse.move(box.x, box.y, { steps: 3 });
  await sleep(220);
  return true;
}

async function openTo(page: Page, openRoot: () => Promise<void>, ancestors: string[]): Promise<MenuItemInfo[]> {
  await openRoot();
  await sleep(220);
  for (let i = 0; i < ancestors.length; i++) {
    if (!(await hoverItem(page, ancestors.slice(0, i), ancestors[i]))) return [];
  }
  return page.evaluate((ancs) => {
    const drop = (window as any).__ui.findDrop(ancs);
    return drop ? (window as any).__ui.itemsOf(drop) : [];
  }, ancestors);
}

async function clickItem(page: Page, ancestors: string[], label: string) {
  await page.evaluate((ancs, l) => {
    const drop = (window as any).__ui.findDrop(ancs);
    const item = drop && (window as any).__ui.itemAt(drop, l);
    item?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, ancestors, label);
}

async function dismissDialogs(page: Page) {
  for (let i = 0; i < 3; i++) {
    const done = await page.evaluate(() => {
      const close = document.querySelector(".dlg-back .sp-close, .dlg-back [aria-label=Close], .dlg-back .dlg-close") as HTMLElement | null;
      if (close) { close.click(); return true; }
      const back = document.querySelector(".dlg-back") as HTMLElement | null;
      if (back) { back.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); back.dispatchEvent(new MouseEvent("click", { bubbles: true })); return true; }
      return false;
    });
    if (!done) return;
    await sleep(180);
  }
}

const SKIP = /sign out|log out|delete permanently|permanently delete/i;

async function walkMenu(page: Page, scope: string, openRoot: () => Promise<void>, ancestors: string[] = [], guard = { n: 0 }) {
  const items = await openTo(page, openRoot, ancestors);
  for (const it of items) {
    if (it.disabled || SKIP.test(it.label)) continue;
    if (++guard.n > 400) return;
    const path = [...ancestors, it.label];
    const key = path.join(" ▸ ");
    if (it.hasSub) {
      await openTo(page, openRoot, ancestors);
      const opened = await hoverItem(page, ancestors, it.label);
      if (!opened) { results[scope].push({ label: key, effect: "noop", note: "parent missing" }); continue; }
      const subOpen = await page.evaluate((ancs) => !!(window as any).__ui.findDrop(ancs), path);
      if (!subOpen) results[scope].push({ label: key, effect: "noop", note: "submenu did not open on hover" });
      else await walkMenu(page, scope, openRoot, path, guard);
      continue;
    }
    await openTo(page, openRoot, ancestors);
    const effect = await classify(page, () => clickItem(page, ancestors, it.label));
    results[scope].push({ label: key, effect });
    await dismissDialogs(page);
    if (!((await page.evaluate(() => location.pathname)).startsWith("/edit"))) {
      await page.goBack(); await sleep(900); return;
    }
  }
}

async function sweepButtons(page: Page, scope: string) {
  // every visible button inside the editor that wasn't covered by the menu walk
  for (let iter = 0; iter < 40; iter++) {
    const label = await page.evaluate(() => {
      const btns = [...document.querySelectorAll("main button, .editor-shell button, body > div button")] as HTMLElement[];
      const b = btns.find((x) => !x.dataset.auditDone && !x.disabled && x.offsetParent !== null &&
        !x.closest(".menu-drop") && !x.closest(".dlg") && !x.closest(".ribbon-tabs") &&
        !/sign out/i.test(x.textContent ?? ""));
      if (!b) return null;
      b.dataset.auditDone = "1";
      return (b.textContent ?? b.getAttribute("aria-label") ?? b.title ?? "?").trim().replace(/\s+/g, " ").slice(0, 60);
    });
    if (!label) break;
    if (SKIP.test(label)) continue;
    const effect = await classify(page, async () => {
      await page.evaluate((l) => {
        const btns = [...document.querySelectorAll("button")] as HTMLElement[];
        const b = btns.find((x) => x.dataset.auditDone === "1" &&
          (x.textContent ?? x.getAttribute("aria-label") ?? x.title ?? "?").trim().replace(/\s+/g, " ").slice(0, 60) === l);
        b?.click();
      }, label);
    });
    results[scope].push({ label: `btn:${label}`, effect });
    const dropOpen = await page.evaluate(() => !!document.querySelector(".menu-drop"));
    if (dropOpen) {
      await walkMenu(page, scope, async () => {
        await page.evaluate((l) => {
          const btns = [...document.querySelectorAll("button")] as HTMLElement[];
          const b = btns.find((x) => x.dataset.auditDone === "1" &&
            (x.textContent ?? x.getAttribute("aria-label") ?? x.title ?? "?").trim().replace(/\s+/g, " ").slice(0, 60) === l);
          b?.click();
        }, label);
      });
      await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    }
    await dismissDialogs(page);
    if (!((await page.evaluate(() => location.pathname)).startsWith("/edit"))) {
      await page.goBack(); await sleep(900);
    }
  }
}

/** Seed each editor with content so edit commands have something to act on —
 *  otherwise Cut/Copy/etc. legitimately no-op on an empty doc. */
async function seed(page: Page, kind: string) {
  if (kind === "writer") {
    await page.evaluate(() => {
      const pm = document.querySelector(".ProseMirror") as HTMLElement | null;
      pm?.focus();
    });
    await page.keyboard.type("The quick brown fox jumps over the lazy dog. Stakeholders reviewed the proposal.");
    await page.keyboard.down("Control"); await page.keyboard.press("a"); await page.keyboard.up("Control");
    await sleep(300);
    await page.keyboard.press("ArrowRight"); // collapse selection but leave text
  } else if (kind === "sheets") {
    // click first cell and type
    await page.evaluate(() => {
      const c = document.querySelector(".sg-cell, td, canvas") as HTMLElement | null;
      c?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      c?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await page.keyboard.type("42"); await page.keyboard.press("Enter");
    await page.keyboard.type("17"); await page.keyboard.press("Enter");
  } else if (kind === "present") {
    // insert a text box so objects exist
    await page.evaluate(() => {
      const b = [...document.querySelectorAll(".ribbon-panel .rb, .ribbon-panel button")] as HTMLElement[];
      b.find((x) => (x.textContent ?? "").trim() === "T")?.click();
    });
    await sleep(300);
    await page.mouse.click(400, 400);
    await page.keyboard.type("Audit slide text");
  }
  await sleep(400);
}

async function auditEditor(page: Page, name: string) {
  results[name] = results[name] ?? [];
  await sleep(1500);

  // ribbon menu tabs (File/Edit/… dropdowns)
  const menuTabs: string[] = await page.evaluate(() =>
    [...document.querySelectorAll(".ribbon-tab.menu-tab")].map((t) => window.__ui.txt(t)));
  for (const tab of menuTabs) {
    const openRoot = async () => {
      const open = await page.evaluate(() => !!(window as any).__ui.rootDrop());
      if (open) return;
      await page.evaluate((label) => {
        const el = [...document.querySelectorAll(".ribbon-tab")] as HTMLElement[];
        el.find((t) => window.__ui.txt(t) === label)?.click();
      }, tab);
    };
    await openRoot();
    await sleep(250);
    const opened = await page.evaluate(() => !!(window as any).__ui.rootDrop());
    if (!opened) results[name].push({ label: `tab:${tab}`, effect: "noop", note: "menu tab did not open" });
    else await walkMenu(page, name, openRoot);
    await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await sleep(150);
  }

  // ribbon panel tabs → each group's buttons + dropdown groups
  const panelTabs: string[] = await page.evaluate(() =>
    [...document.querySelectorAll(".ribbon-tab:not(.menu-tab)")].map((t) => window.__ui.txt(t)));
  for (const tab of panelTabs) {
    await page.evaluate((label) => {
      const el = [...document.querySelectorAll(".ribbon-tab")] as HTMLElement[];
      el.find((t) => window.__ui.txt(t) === label)?.click();
    }, tab);
    await sleep(280);
    // dropdown groups first
    const groups: string[] = await page.evaluate(() =>
      [...document.querySelectorAll(".ribbon-panel .rbg-menu-btn")].map((b) => window.__ui.txt(b)));
    for (const g of groups) {
      const openRoot = async () => {
        const open = await page.evaluate(() => !!(window as any).__ui.rootDrop());
        if (open) return;
        await page.evaluate((label) => {
          const el = [...document.querySelectorAll(".ribbon-panel .rbg-menu-btn")] as HTMLElement[];
          el.find((b) => window.__ui.txt(b) === label)?.click();
        }, g);
      };
      await openRoot();
      await sleep(220);
      const opened = await page.evaluate(() => !!(window as any).__ui.rootDrop());
      const key = `${tab} ▸ ${g}`;
      if (!opened) results[name].push({ label: key, effect: "noop", note: "group dropdown did not open" });
      else { results[name].push({ label: key, effect: "dropdown" }); await walkMenu(page, name, openRoot); }
      await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      await sleep(150);
      if (!((await page.evaluate(() => location.pathname)).startsWith("/edit"))) { await page.goBack(); await sleep(900); }
    }
    // leaf ribbon buttons (not dropdown groups, not inside open menus)
    const btns: string[] = await page.evaluate(() =>
      [...document.querySelectorAll(".ribbon-panel button, .ribbon-panel select, .ribbon-end button")]
        .filter((b) => !b.classList.contains("rbg-menu-btn") && !b.closest(".menu-drop") && !(b as HTMLButtonElement).disabled)
        .map((b) => window.__ui.txt(b).slice(0, 60)));
    for (const b of btns) {
      if (!b || SKIP.test(b)) continue;
      const effect = await classify(page, async () => {
        await page.evaluate((l) => {
          const el = [...document.querySelectorAll(".ribbon-panel button, .ribbon-end button")] as HTMLElement[];
          el.find((x) => window.__ui.txt(x).slice(0, 60) === l)?.click();
        }, b);
      });
      results[name].push({ label: `${tab} ▸ ${b}`, effect });
      const dropOpen = await page.evaluate(() => !!document.querySelector(".menu-drop"));
      if (dropOpen) {
        await walkMenu(page, name, async () => {
          await page.evaluate((l) => {
            const el = [...document.querySelectorAll(".ribbon-panel button, .ribbon-end button")] as HTMLElement[];
            el.find((x) => window.__ui.txt(x).slice(0, 60) === l)?.click();
          }, b);
        });
        await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      }
      await dismissDialogs(page);
      if (!((await page.evaluate(() => location.pathname)).startsWith("/edit"))) { await page.goBack(); await sleep(900); }
    }
  }

  // Writer menubar
  const menubtns: string[] = await page.evaluate(() =>
    [...document.querySelectorAll(".menubar .menu-btn")].map((b) => window.__ui.txt(b)));
  for (const mb of menubtns) {
    const openRoot = async () => {
      const open = await page.evaluate(() => !!(window as any).__ui.rootDrop());
      if (open) return;
      await page.evaluate((label) => {
        const el = [...document.querySelectorAll(".menubar .menu-btn")] as HTMLElement[];
        el.find((b) => window.__ui.txt(b) === label)?.click();
      }, mb);
    };
    await openRoot();
    await sleep(250);
    const opened = await page.evaluate(() => !!(window as any).__ui.rootDrop());
    if (!opened) results[name].push({ label: `menu:${mb}`, effect: "noop", note: "menubar did not open" });
    else await walkMenu(page, name, openRoot);
    await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await sleep(150);
    if (!((await page.evaluate(() => location.pathname)).startsWith("/edit"))) { await page.goBack(); await sleep(900); }
  }

  await sweepButtons(page, name);
}

// ---------- run ----------
const { browser, page } = await newPage();
await page.evaluateOnNewDocument(HELPERS as never);
await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
await sleep(2200);

const MIN_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 55>>stream\nBT /F1 24 Tf 72 700 Td (Kreatix audit PDF) Tj ET\nendstream\nendobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";
writeFileSync("audit-min.pdf", MIN_PDF);

for (const kind of ["writer", "sheets", "present", "pdf"]) {
  await page.goto(`${BASE}/home`, { waitUntil: "domcontentloaded" });
  await sleep(1600);
  if (kind === "pdf") {
    const input = await page.$("input[type=file]");
    if (!input) { results.pdf = [{ label: "(editor)", effect: "error", note: "no file input" }]; continue; }
    await input.uploadFile("audit-min.pdf");
    await sleep(2500);
    if (!((await page.evaluate(() => location.pathname)).startsWith("/edit"))) {
      // find the uploaded file in the list (wait for it to appear)
      for (let i = 0; i < 10; i++) {
        const ok = await page.evaluate(() => {
          const f = [...document.querySelectorAll(".file")] as HTMLElement[];
          const row = f.find((x) => (x.textContent ?? "").includes("audit-min"));
          if (!row) return false;
          row.querySelector<HTMLElement>(".thumb")?.click();
          return true;
        });
        if (ok) break;
        await sleep(600);
      }
      await sleep(2500);
    }
  } else {
    await page.evaluate((k) => {
      const card = [...document.querySelectorAll(".app-card")] as HTMLElement[];
      card.find((c) => (c.textContent ?? "").toLowerCase().includes(k))?.click();
    }, kind);
    await page.waitForFunction(() => location.pathname.startsWith("/edit"), { timeout: 20000 }).catch(() => {});
    await sleep(1500);
  }
  const where = await page.evaluate(() => location.pathname);
  if (!where.startsWith("/edit")) { results[kind] = [{ label: "(editor)", effect: "error", note: `never reached editor (${where})` }]; continue; }
  await seed(page, kind);
  await auditEditor(page, kind);
}

writeFileSync("audit-report.json", JSON.stringify({ results, errors }, null, 2));
console.log("=== AUDIT RESULTS ===");
for (const [scope, rows] of Object.entries(results)) {
  console.log(`\n## ${scope} (${rows.length} controls)`);
  for (const r of rows) console.log(`  ${r.effect.padEnd(24)} ${r.label}${r.note ? `  (${r.note})` : ""}`);
}
console.log("\n=== PAGE/CONSOLE ERRORS ===");
for (const e of [...new Set(errors)].slice(0, 80)) console.log(" ", e);
await browser.close();
