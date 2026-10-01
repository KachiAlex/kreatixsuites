// Preload — the only bridge between the web bundle and the OS. Exposed as
// window.kxDesktop; everything goes through ipcRenderer.invoke/on.
import { contextBridge, ipcRenderer } from "electron";

const invoke = <T>(ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args) as Promise<T>;

contextBridge.exposeInMainWorld("kxDesktop", {
  isDesktop: true,
  platform: process.platform,
  apiBase: () => invoke<string>("kx:apiBase"),

  // filesystem (used by file-association opens + save-write-back)
  readFile: (path: string) => invoke<{ ok: boolean; name?: string; data?: string; size?: number; error?: string }>("kx:readFile", path),
  writeFile: (path: string, dataBase64: string) => invoke<{ ok: boolean; error?: string }>("kx:writeFile", path, dataBase64),
  openDialog: () => invoke<string | null>("kx:openDialog"),
  saveDialog: (defaultName: string) => invoke<string | null>("kx:saveDialog", defaultName),
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

  // subscription entitlement (DPAPI-encrypted store in userData)
  entitlement: {
    get: () => invoke<{ ok: boolean; token?: string }>("kx:entitlement:get"),
    set: (token: string) => invoke<{ ok: boolean; error?: string }>("kx:entitlement:set", token),
    clear: () => invoke<{ ok: boolean }>("kx:entitlement:clear"),
  },
});
