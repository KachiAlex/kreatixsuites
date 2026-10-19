// Shared import ceilings — past these a browser tab stalls on unzip/parse work
// anyway; fail fast with a readable reason instead.
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024; // compressed file

export function assertImportSize(file: File | Blob): void {
  if (file.size > MAX_IMPORT_BYTES)
    throw new Error(`That file is too large to import (${Math.round(file.size / 1048576)} MB — max ${Math.round(MAX_IMPORT_BYTES / 1048576)} MB)`);
}

/** Read a text-ish file honoring BOMs with a windows-1252 fallback —
 *  File.text() assumes UTF-8, so Excel CSVs and Notepad files authored on
 *  non-English Windows come through as mojibake (é → Ã©). */
export async function readTextAuto(f: File | Blob): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}
