// Shared import ceilings — past these a browser tab stalls on unzip/parse work
// anyway; fail fast with a readable reason instead.
export const MAX_IMPORT_BYTES = 150 * 1024 * 1024; // compressed file

export function assertImportSize(file: File): void {
  if (file.size > MAX_IMPORT_BYTES)
    throw new Error(`That file is too large to import (${Math.round(file.size / 1048576)} MB — max ${Math.round(MAX_IMPORT_BYTES / 1048576)} MB)`);
}
