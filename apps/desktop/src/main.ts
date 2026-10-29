// Kreatix Desktop — Electron main process.
//
// The web app bundle (apps/web/dist) is served over a custom kx:// scheme so
// it works fully offline, keeps fetch/IDB/cookie semantics, and stays versioned
// with the app. REST/WS traffic goes to the production API origin.
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, shell } from "electron";
import electronUpdater from "electron-updater";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const API_BASE = "https://suites.kreatixtech.com";
const SCHEME = "kx";
// electron-updater is CJS — default-import + destructure (named ESM import
// throws "Named export 'autoUpdater' not found" in the packaged app)
const { autoUpdater } = electronUpdater;
// Google OAuth "Desktop app" client — public identifier only; the secret
// lives on the API (token exchange happens in /api/auth/google/code).
const GOOGLE_DESKTOP_CLIENT_ID = "205418150362-e9nou2bj4b7lqi72s6bjb4fml99esedg.apps.googleusercontent.com";

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

// ---------- Google sign-in (system browser + PKCE + loopback) ----------
// The app can't host Google's consent in the embedded window, so we open the
// user's default browser, catch the redirect on a throwaway 127.0.0.1
// listener, and hand {code, verifier, redirectUri} back to the renderer —
// the API does the actual token exchange with the desktop client secret.

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

ipcMain.handle("kx:googleSignIn", () => new Promise<{ code: string; codeVerifier: string; redirectUri: string }>((resolve, reject) => {
  const verifier = b64url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const state = b64url(randomBytes(16));
  let redirectUri = "";

  const server = http.createServer((req, res) => {
    try {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/oauth") { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      const st = u.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><body style='font-family:sans-serif;text-align:center;padding-top:60px'>"
        + "<h2>Signed in — you can close this tab</h2><p>Return to Kreatix Suites.</p></body></html>");
      clearTimeout(timer);
      server.close();
      if (err || !code || st !== state) {
        reject(new Error(err === "access_denied" ? "cancelled" : "invalid_state"));
      } else {
        resolve({ code, codeVerifier: verifier, redirectUri });
      }
    } catch (e) {
      clearTimeout(timer);
      server.close();
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });

  const timer = setTimeout(() => {
    server.close();
    reject(new Error("Google sign-in timed out"));
  }, 180_000);
  // no response → also fail fast if the port can't bind at all
  server.on("error", (e) => { clearTimeout(timer); reject(e); });
  server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    redirectUri = `http://127.0.0.1:${port}/oauth`;
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    url.search = new URLSearchParams({
      client_id: GOOGLE_DESKTOP_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    void shell.openExternal(url.toString());
  });
}));

ipcMain.handle("kx:readFile", (_e, filePath: string) => {
  try {
    const data = fs.readFileSync(filePath);
    return { ok: true, name: path.basename(filePath), data: data.toString("base64"), size: data.length };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Save-as: the user picks the destination in a native dialog and the main
// process writes the bytes — the renderer never chooses a path.
ipcMain.handle("kx:saveFile", async (_e, defaultName: string, dataBase64: string) => {
  if (!mainWindow) return { ok: false, error: "no window" };
  const r = await dialog.showSaveDialog(mainWindow, { defaultPath: path.basename(defaultName) });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(r.filePath, Buffer.from(dataBase64, "base64"));
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Render a standalone print document to PDF with Electron's own engine, then
// save-as. The print dialog isn't reliable inside the app, so this path skips it.
ipcMain.handle("kx:printToPdf", async (_e, html: string, defaultName: string) => {
  if (!mainWindow) return { ok: false, error: "no window" };
  const tmp = path.join(app.getPath("temp"), `kx-print-${randomBytes(6).toString("hex")}.html`);
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
  try {
    fs.writeFileSync(tmp, html, "utf8");
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, pageSize: "Letter" });
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.basename(defaultName), filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, pdf);
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    win.destroy();
    fs.promises.rm(tmp, { force: true }).catch(() => {});
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


ipcMain.handle("kx:showInFolder", (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle("kx:pendingFiles", () => pendingFiles.splice(0));
// Renderer signals it has subscribed to "kx:open-file" — only now is a sent
// event guaranteed to land. Flush anything queued from argv / protocol.
ipcMain.on("kx:renderer-ready", () => { rendererReady = true; flushPendingFiles(); });

// ---------- auto-update ----------
// electron-updater checks the GitHub releases feed (build.publish in
// package.json) for latest.yml; only active on packaged builds. Status is
// relayed to the renderer so the shell can surface a restart affordance.
type UpdateStatus =
  | { state: "checking" | "available" | "none" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };
let lastUpdate: UpdateStatus = { state: "none" };
const sendUpdate = (s: UpdateStatus) => {
  lastUpdate = s;
  mainWindow?.webContents.send("kx:update", s);
};
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on("checking-for-update", () => sendUpdate({ state: "checking" }));
autoUpdater.on("update-available", () => sendUpdate({ state: "available" }));
autoUpdater.on("update-not-available", () => sendUpdate({ state: "none" }));
autoUpdater.on("download-progress", (p) => sendUpdate({ state: "downloading", percent: Math.round(p.percent) }));
autoUpdater.on("update-downloaded", (i) => sendUpdate({ state: "downloaded", version: i.version }));
autoUpdater.on("error", (e) => sendUpdate({ state: "error", message: e?.message ?? String(e) }));

ipcMain.handle("kx:update:status", () => lastUpdate);
ipcMain.handle("kx:update:check", async () => {
  if (!app.isPackaged) return { ok: false, error: "updates only run on packaged builds" };
  try { await autoUpdater.checkForUpdates(); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle("kx:update:install", () => {
  if (lastUpdate.state === "downloaded") autoUpdater.quitAndInstall();
});

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
    if (app.isPackaged) {
      // launch check + hourly re-check; failures are silent in the renderer
      // (state:"error") so an absent feed never interrupts the user
      setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 8000);
      setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 3600_000);
    }
    app.on("activate", () => { if (!mainWindow) createWindow(); });
  });

  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
}
