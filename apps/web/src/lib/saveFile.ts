// Unified file save. Desktop: native Save-As dialog (main process writes the
// file). Browser: classic <a download> blob anchor.
// Native mobile (Capacitor WebView): a.download is a no-op there — no
// DownloadListener is wired — so blobs are written to the public Documents
// dir via @capacitor/filesystem; if that fails (old device, scoped storage
// edge) the file is written to the app cache and handed to the share sheet.
// Either way a "kreatix:toast" event lets the shell confirm the save.
import { desktop, isDesktop, isNativeMobile } from "./platform";

export const toast = (m: string) =>
  window.dispatchEvent(new CustomEvent("kreatix:toast", { detail: m }));

const blobToBase64 = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]/g, "_") || "download";

async function saveNative(blob: Blob, filename: string): Promise<void> {
  const name = safeName(filename);
  const { Filesystem, Directory } = await import("@capacitor/filesystem");
  const data = await blobToBase64(blob);
  try {
    await Filesystem.writeFile({
      path: `Kreatix/${name}`, data, directory: Directory.Documents, recursive: true,
    });
    toast(`Saved to Documents/Kreatix — ${name}`);
  } catch {
    // Documents unavailable → cache + share sheet so the user can still
    // move the file wherever they want
    const cached = await Filesystem.writeFile({ path: name, data, directory: Directory.Cache });
    const { Share } = await import("@capacitor/share");
    await Share.share({ title: name, url: cached.uri });
  }
}

/**
 * Save `blob` to the user's device as `filename`. Resolves true once the file
 * is written; false when the user cancels the save dialog. Failures toast.
 * Desktop shows a native Save-As dialog (the shell writes the bytes); native
 * mobile writes to Documents/Kreatix; the browser triggers a download.
 */
export async function saveFile(blob: Blob, filename: string): Promise<boolean> {
  if (isDesktop && desktop) {
    const name = safeName(filename);
    const r = await desktop.saveFile(name, await blobToBase64(blob));
    if (!r.ok && !r.canceled) toast(`Couldn't save ${name}`);
    return !!r.ok;
  }
  if (isNativeMobile) {
    try {
      await saveNative(blob, filename);
      return true;
    } catch {
      toast(`Couldn't save ${safeName(filename)}`);
      return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoking immediately after click can cancel the download in some engines
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return true;
}
