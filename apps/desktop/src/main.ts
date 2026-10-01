// Kreatix Desktop — Electron main process.
//
// The web app bundle (apps/web/dist) is served over a custom kx:// scheme so
// it works fully offline, keeps fetch/IDB/cookie semantics, and stays versioned
// with the app. REST/WS traffic goes to the production API origin.
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const API_BASE = "https://suites.kreatixtech.com";
const SCHEME = "kx";

// The app manages its own theme via [data-theme] — Chromium's algorithmic
// auto-dark (WebContentsForceDark) repaints light surfaces navy when the OS
// flips to dark, producing the dark-on-dark sidebar seen on Windows.
app.commandLine.appendSwitch("disable-features", "WebContentsForceDark");
const HOST = "app";
const APP_URL = `${SCHEME}://${HOST}/`;

const webDist = app.isPackaged
  ? path.join(process.resourcesPath, "web")
  : path.join(import.meta.dirname, "..", "..", "web", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".gif": "image/gif", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".wasm": "application/wasm", ".webmanifest": "application/manifest+json",
  ".gz": "application/gzip", ".txt": "text/plain", ".map": "application/json",
};

// CSP for the bundled shell — same shape as production nginx, plus the API
// origin in connect-src since pages are no longer same-origin with the API.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  `connect-src 'self' ${API_BASE} wss://suites.kreatixtech.com`,
  "worker-src 'self' blob:",
  "media-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "manifest-src 'self'",
].join("; ");

// must run before app.whenReady — register the scheme as privileged so fetch,
// workers, streaming responses and IDB behave like a real origin
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true } },
]);

let mainWindow: BrowserWindow | null = null;
// Renderer sets this once it has subscribed to "kx:open-file" (React mount is
// later than did-finish-load) — IPC sent before the listener attaches is lost.
let rendererReady = false;
const pendingFiles: string[] = [];

/** argv file paths the OS handed us (double-click / "Open with"). */
const fileArgs = (argv: string[]) =>
  argv.filter((a) => {
    if (a.startsWith("-") || a.startsWith(`${SCHEME}:`)) return false;
    try { return fs.statSync(a).isFile(); } catch { return false; }
  });

const deliverFile = (p: string) => {
  if (mainWindow && rendererReady) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    mainWindow.webContents.send("kx:open-file", p);
  } else pendingFiles.push(p);
};

const flushPendingFiles = () => {
  for (const p of pendingFiles.splice(0)) deliverFile(p);
};

const handleProtocol = async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(webDist, rel));
  // path traversal guard + SPA fallback
  const target = file.startsWith(path.normalize(webDist)) && fs.existsSync(file) && fs.statSync(file).isFile()
    ? file
    : path.join(webDist, "index.html");
  const res = await net.fetch(pathToFileURL(target).toString());
  if (!target.endsWith(".html")) return res;
  const headers = new Headers(res.headers);
  headers.set("content-security-policy", CSP);
  headers.set("content-type", "text/html");
  return new Response(res.body, { status: res.status, headers });
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#FFF9F4",
    icon: path.join(webDist, "icon-512.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("[kreatix] renderer gone:", details.reason, details.exitCode);
  });
  mainWindow.webContents.on("console-message", (_e, _l, msg) => {
    if (/error|uncaught/i.test(msg)) console.error("[renderer]", msg);
  });

  // keep every navigation inside the kx:// shell; open external http(s) in the
  // system browser instead of spawning Electron windows
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(`${SCHEME}:`)) return { action: "allow" };
    if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(APP_URL) && !url.startsWith("devtools:")) {
      e.preventDefault();
      if (url.startsWith("https:") || url.startsWith("http:")) void shell.openExternal(url);
    }
  });

  void mainWindow.loadURL(APP_URL);
  mainWindow.webContents.once("did-finish-load", () => {
    // KX_SMOKE=1 → headless smoke test: report the loaded doc and quit (CI)
    if (process.env.KX_SMOKE) {
      mainWindow?.webContents
        .executeJavaScript("document.title + '|' + location.origin")
        .then((r) => { console.log("SMOKE-OK:", r); app.quit(); })
        .catch((e) => { console.error("SMOKE-FAIL:", e); app.exit(1); });
    }
  });
  mainWindow.on("closed", () => { mainWindow = null; rendererReady = false; });
};

// ---------- IPC ----------

ipcMain.handle("kx:apiBase", () => API_BASE);

ipcMain.handle("kx:readFile", (_e, filePath: string) => {
  try {
    const data = fs.readFileSync(filePath);
    return { ok: true, name: path.basename(filePath), data: data.toString("base64"), size: data.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("kx:writeFile", (_e, filePath: string, dataBase64: string) => {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.from(dataBase64, "base64"));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle("kx:openDialog", async () => {
  if (!mainWindow) return null;
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [
      { name: "All supported", extensions: ["docx", "doc", "xlsx", "xls", "csv", "pptx", "pdf", "txt", "odt", "ods", "odp"] },
      { name: "Documents", extensions: ["docx", "doc", "odt", "txt"] },
      { name: "Spreadsheets", extensions: ["xlsx", "xls", "csv", "ods"] },
      { name: "Presentations", extensions: ["pptx", "odp"] },
      { name: "PDF", extensions: ["pdf"] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle("kx:saveDialog", async (_e, defaultName: string) => {
  if (!mainWindow) return null;
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: defaultName });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle("kx:showInFolder", (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle("kx:pendingFiles", () => pendingFiles.splice(0));
// Renderer signals it has subscribed to "kx:open-file" — only now is a sent
// event guaranteed to land. Flush anything queued from argv / protocol.
ipcMain.on("kx:renderer-ready", () => { rendererReady = true; flushPendingFiles(); });

// entitlement persistence — encrypted with Windows DPAPI via safeStorage
const entitlementPath = () => path.join(app.getPath("userData"), "entitlement.bin");
ipcMain.handle("kx:entitlement:get", () => {
  try {
    const raw = fs.readFileSync(entitlementPath());
    return { ok: true, token: safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString("utf8") };
  } catch { return { ok: false }; }
});
ipcMain.handle("kx:entitlement:set", (_e, token: string) => {
  try {
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(token) : Buffer.from(token, "utf8");
    fs.mkdirSync(path.dirname(entitlementPath()), { recursive: true });
    fs.writeFileSync(entitlementPath(), data);
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle("kx:entitlement:clear", () => {
  try { fs.unlinkSync(entitlementPath()); } catch { /* absent */ }
  return { ok: true };
});

// ---------- lifecycle ----------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    for (const f of fileArgs(argv)) deliverFile(f);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    protocol.handle(SCHEME, handleProtocol);
    app.setAsDefaultProtocolClient(SCHEME);
    for (const f of fileArgs(process.argv.slice(1))) pendingFiles.push(f);
    createWindow();
    app.on("activate", () => { if (!mainWindow) createWindow(); });
  });

  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
