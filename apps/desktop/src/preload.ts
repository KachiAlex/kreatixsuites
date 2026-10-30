// Preload — the only bridge between the web bundle and the OS. Exposed as
// window.kxDesktop; everything goes through ipcRenderer.invoke/on.
import { contextBridge, ipcRenderer } from "electron";

const invoke = <T>(ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args) as Promise<T>;

const appFlag = "--kx-app=";
const appSlug = process.argv.find((a) => a.startsWith(appFlag))?.slice(appFlag.length) || null;

contextBridge.exposeInMainWorld("kxDesktop", {
  isDesktop: true,
  platform: process.platform,
  app: appSlug,
  apiBase: () => invoke<string>("kx:apiBase"),

  // Google sign-in — opens the system browser, returns the auth code + PKCE
  // verifier + loopback redirectUri for /api/auth/google/code
  googleSignIn: () => invoke<{ code: string; codeVerifier: string; redirectUri: string }>("kx:googleSignIn"),

  // filesystem (used by file-association opens + save-write-back)
  readFile: (path: string) => invoke<{ ok: boolean; name?: string; data?: string; size?: number; error?: string }>("kx:readFile", path),
  saveFile: (defaultName: string, dataBase64: string) =>
    invoke<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>("kx:saveFile", defaultName, dataBase64),
  saveAs: (defaultPath: string, dataBase64: string) =>
    invoke<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>("kx:saveAs", defaultPath, dataBase64),
  overwrite: (filePath: string, dataBase64: string) =>
    invoke<{ ok: boolean; path?: string; error?: string }>("kx:overwrite", filePath, dataBase64),
  printToPdf: (html: string, defaultName: string) =>
    invoke<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>("kx:printToPdf", html, defaultName),
  openDialog: () => invoke<string | null>("kx:openDialog"),
  showInFolder: (path: string) => invoke<void>("kx:showInFolder", path),

  // files passed on argv (double-click) — queued in main until the renderer
  // signals readiness, then pushed via onOpenFile. pendingFiles() remains a
  // pull fallback; both drain the same queue so nothing double-opens.
  pendingFiles: () => invoke<string[]>("kx:pendingFiles"),
  onOpenFile: (cb: (path: string) => void) => {
    const l = (_e: unknown, p: string) => cb(p);
    ipcRenderer.on("kx:open-file", l);
    ipcRenderer.send("kx:renderer-ready");
    return () => ipcRenderer.off("kx:open-file", l);
  },

  // Kreatavi — opens the signed Mail hand-off in its own window
  mail: {
    open: (url: string) => invoke<{ ok: boolean; error?: string }>("kx:mail:open", url),
  },
  closeWindow: () => invoke<void>("kx:window:close"),

  // subscription entitlement (DPAPI-encrypted store in userData)
  entitlement: {
    get: () => invoke<{ ok: boolean; token?: string }>("kx:entitlement:get"),
    set: (token: string) => invoke<{ ok: boolean; error?: string }>("kx:entitlement:set", token),
    clear: () => invoke<{ ok: boolean }>("kx:entitlement:clear"),
  },

  // auto-update — status relayed from main; check/install are user-driven
  updates: {
    status: () => invoke<unknown>("kx:update:status"),
    check: () => invoke<{ ok: boolean; error?: string }>("kx:update:check"),
    install: () => invoke<void>("kx:update:install"),
    onStatus: (cb: (s: unknown) => void) => {
      const l = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on("kx:update", l);
      return () => ipcRenderer.off("kx:update", l);
    },
  },
});
