/**
 * Mobile audit — loads the app at phone/tablet viewports (touch enabled),
 * walks Home → Drive → every editor via the anonymous tier, and asserts no
 * page overflows horizontally (scrollWidth and innerWidth must stay at the
 * device width — Chrome expands innerWidth when content forces shrink-to-fit).
 * Screenshots land in ./mobile-audit/.
 *
 *   pnpm --filter @kreatix/web preview   # serve dist on :4173
 *   tsx scripts/mobile-audit.mts [baseURL]
 */
import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";

const BASE = process.argv[2] ?? "http://localhost:4173";
const OUT = new URL("../mobile-audit/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT, { recursive: true });

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "chrome",
].find((p) => existsSync(p)) ?? "chrome";

const VIEWPORTS = [
  { name: "iphone-se", width: 375, height: 667 },
  { name: "iphone-14", width: 393, height: 852 },
  { name: "pixel", width: 412, height: 915 },
  { name: "ipad", width: 768, height: 1024 },
];

// minimal valid single-page PDF for the upload→PdfEditor path
const MINI_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
const pdfPath = `${OUT}audit-sample.pdf`;
writeFileSync(pdfPath, MINI_PDF);

const browser = await puppeteer.launch({ headless: true, executablePath: CHROME });
const failures: string[] = [];

async function shot(page: puppeteer.Page, name: string, vw: number) {
  await new Promise((r) => setTimeout(r, 700));
  await page.screenshot({ path: `${OUT}${name}.png` });
  const overflow = await page.evaluate(() => ({
    w: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    el: (() => {
      // widest non-clipped element crossing the layout edge (diagnostic only)
      let worst: Element | null = null, worstW = 0;
      document.querySelectorAll("body *").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > worstW && r.width > 4) {
          let clips = false, n = el.parentElement;
          while (n) { const ox = getComputedStyle(n).overflowX; if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") { clips = true; break; } n = n.parentElement; }
          if (!clips && (r.right > document.documentElement.clientWidth + 2 || r.left < -2)) { worst = el; worstW = r.width; }
        }
      });
      return worst ? `${worst.tagName}.${(worst as HTMLElement).className?.toString().slice(0, 60)}` : null;
    })(),
  }));
  // innerWidth > vw means Chrome shrink-to-fit expanded the layout viewport: real overflow
  const bad = overflow.w > vw + 2 || overflow.iw > vw + 2;
  console.log(`${bad ? "FAIL" : "ok  "} ${name}  scrollW=${overflow.w} innerW=${overflow.iw}/${vw}${overflow.el ? `  widest:${overflow.el}` : ""}`);
  if (bad) failures.push(`${name}: scrollW=${overflow.w} innerW=${overflow.iw} (device ${vw}) (${overflow.el})`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function openDrawer(page: puppeteer.Page) {
  const burger = await page.$(".nav-burger");
  if (!burger) return false;
  const cls = await burger.evaluate((b) => getComputedStyle(b).display);
  if (cls === "none") return false;
  await burger.tap();
  await sleep(400);
  return true;
}

async function createDoc(page: puppeteer.Page, kind: string) {
  if (!(await openDrawer(page))) return false;
  await page.evaluate(() => (document.querySelector(".sidebar .create") as HTMLElement)?.click());
  await sleep(300);
  await page.evaluate((k) => {
    const b = [...document.querySelectorAll(".create-menu button")].find((x) => x.textContent?.includes(k));
    (b as HTMLElement)?.click();
  }, kind);
  await sleep(2500);
  return true;
}

for (const vp of VIEWPORTS) {
  // isolated context per viewport: localStorage (anon flag) must not leak across runs
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ ...vp, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  // guest landing first — entering the anonymous tier makes "/" redirect to /home
  await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 45000 });
  await shot(page, `${vp.name}-landing`, vp.width);
  // then the app login → anonymous tier into the real shell
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle2", timeout: 45000 });
  await shot(page, `${vp.name}-login`, vp.width);
  if (await page.$(".anon-btn")) {
    await page.click(".anon-btn");
    await sleep(1500);
  }
  await shot(page, `${vp.name}-home`, vp.width);

  // nav drawer
  if (await openDrawer(page)) {
    await shot(page, `${vp.name}-drawer`, vp.width);
    await page.evaluate(() => (document.querySelector(".sidebar-close") as HTMLElement)?.click());
    await sleep(400);
  }

  // each editor via the anonymous tier
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle2" }).catch(() => {});
  if (await createDoc(page, "Writer")) await shot(page, `${vp.name}-writer`, vp.width);

  await page.goto(`${BASE}/home`, { waitUntil: "networkidle2" }).catch(() => {});
  if (await createDoc(page, "Sheets")) await shot(page, `${vp.name}-sheets`, vp.width);

  await page.goto(`${BASE}/home`, { waitUntil: "networkidle2" }).catch(() => {});
  if (await createDoc(page, "Present")) await shot(page, `${vp.name}-present`, vp.width);

  // PDF editor via upload of a real .pdf file, then open it from Drive
  await page.goto(`${BASE}/home`, { waitUntil: "networkidle2" }).catch(() => {});
  if (await openDrawer(page)) {
    const input = await page.$(".sidebar input[type=file]");
    if (input) {
      await input.uploadFile(pdfPath);
      await sleep(1500);
    }
  }
  await page.goto(`${BASE}/drive/all`, { waitUntil: "networkidle2" }).catch(() => {});
  await sleep(600);
  const pdfOpened = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".file")].find((x) => x.textContent?.toLowerCase().includes(".pdf"));
    if (!row) return false;
    ((row.querySelector(".thumb") ?? row) as HTMLElement).click();
    return true;
  });
  if (pdfOpened) {
    await sleep(3000);
    await shot(page, `${vp.name}-pdf`, vp.width);
  } else {
    console.log("skip pdf — upload did not produce a drive row");
  }

  // drive list
  await page.goto(`${BASE}/drive/all`, { waitUntil: "networkidle2" }).catch(() => {});
  await shot(page, `${vp.name}-drive`, vp.width);

  // admin surface (anon sees the gated shell — still a valid overflow check)
  await page.goto(`${BASE}/admin`, { waitUntil: "networkidle2" }).catch(() => {});
  await shot(page, `${vp.name}-admin`, vp.width);

  await ctx.close();
}

await browser.close();
console.log(failures.length ? `\nFAILURES:\n${failures.join("\n")}` : "\nAll screens pass — no horizontal overflow.");
process.exit(failures.length ? 1 : 0);
