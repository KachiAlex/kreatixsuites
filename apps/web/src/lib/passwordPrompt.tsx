// Imperative password prompt for encrypted files — mounts a modal via a
// detached React root (same pattern as present/video.ts) so it can be
// awaited from non-component code like the import paths.
import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { decryptOoxml, ooxmlEncScheme, WrongPasswordError } from "./ooxmlCrypto";

export class OpenCancelledError extends Error {
  constructor() { super("Open cancelled"); this.name = "OpenCancelledError"; }
}

function PasswordForm({ fileName, wrong, onSubmit, onCancel }: {
  fileName: string; wrong: boolean;
  onSubmit: (pw: string) => void; onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <div className="dlg-back" onClick={onCancel}>
      <div className="dlg" onClick={(e) => e.stopPropagation()}>
        <h3>Password required</h3>
        <p style={{ fontSize: 12, color: "var(--muted)", margin: "8px 0 14px" }}>
          {wrong ? "Incorrect password — try again."
            : <><b>{fileName}</b> is password-protected. Enter the password to open it.</>}
        </p>
        <form onSubmit={(e) => { e.preventDefault(); onSubmit(pw); }}>
          <input type="password" autoFocus value={pw} placeholder="Password"
            onChange={(e) => setPw(e.target.value)}
            style={{ width: "100%", height: 40, border: "1px solid var(--line)", borderRadius: 11, padding: "0 11px", fontSize: 12, background: "#FBFAF9", boxSizing: "border-box" }} />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 14 }}>
            <button type="button" className="btn" style={{ height: 34, padding: "0 14px" }} onClick={onCancel}>Cancel</button>
            <button type="submit" className="btn-primary" style={{ height: 34, padding: "0 18px" }}>Open</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Mount a modal asking for the file's password. Resolves null on cancel. */
function askPassword(fileName: string, wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (v: string | null) => {
      flushSync(() => root.render(null));
      root.unmount();
      host.remove();
      resolve(v);
    };
    flushSync(() => root.render(createElement(PasswordForm, {
      fileName, wrong,
      onSubmit: (pw: string) => done(pw),
      onCancel: () => done(null),
    })));
  });
}

/**
 * If `file` is a password-protected OOXML package, prompt for the password
 * (retrying on a wrong password) and return a decrypted File. Returns the
 * file unchanged when it isn't encrypted; throws OpenCancelledError when
 * the user cancels the prompt, or Error on unsupported schemes.
 */
export async function ensureDecryptedFile(file: File): Promise<File> {
  // Cheap gate first: encrypted OOXML is a CFB container, so the 8-byte
  // magic decides whether the full-buffer CFB scan is even needed.
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  if (head[0] !== 0xd0) return file;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const scheme = ooxmlEncScheme(bytes);
  if (!scheme) return file;
  if (scheme !== "agile")
    throw new Error("This file uses an older Office encryption scheme that Kreatix can't open yet");
  let wrong = false;
  for (;;) {
    const pw = await askPassword(file.name, wrong);
    if (pw === null) throw new OpenCancelledError();
    try {
      const zip = await decryptOoxml(bytes, pw);
      return new File([zip.buffer as ArrayBuffer], file.name, { type: file.type });
    } catch (e) {
      if (e instanceof WrongPasswordError) { wrong = true; continue; }
      throw e;
    }
  }
}
