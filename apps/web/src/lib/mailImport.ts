import { api, ApiError } from "./api";

export interface ImportStats { imported: number; skipped: number; failed: number; folder: string }
export interface ImportProgress { file: number; files: number; name: string; sent: number; total: number; stage: "upload" | "processing" }

export const MAX_IMPORT_BYTES = 4 * 1024 * 1024 * 1024;
const CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Upload mail archives in resumable 8 MB chunks, then poll the background
 *  import until each file finishes. Pass memberId to import into another
 *  member's mailbox (org admins only). */
export async function importMailArchive(
  files: File[],
  opts: { folder: string; memberId?: string },
  onProgress: (p: ImportProgress) => void,
): Promise<ImportStats> {
  const base = opts.memberId ? `/api/mail/import-as/${opts.memberId}` : "/api/mail";
  const total: ImportStats = { imported: 0, skipped: 0, failed: 0, folder: opts.folder };

  for (const [i, file] of files.entries()) {
    const report = (sent: number, stage: ImportProgress["stage"]) =>
      onProgress({ file: i + 1, files: files.length, name: file.name, sent, total: file.size, stage });

    const session = await api.post<{ id: string; maxBytes: number }>(`${base}/import-sessions`, { folder: opts.folder });
    if (file.size > Math.min(session.maxBytes, MAX_IMPORT_BYTES)) throw new Error(`${file.name} is larger than the 4 GB import limit`);

    let offset = 0;
    let retries = 0;
    while (offset < file.size) {
      try {
        const r = await api.putBlob<{ size: number }>(
          `${base}/import-sessions/${session.id}/chunks?offset=${offset}`,
          file.slice(offset, offset + CHUNK_BYTES));
        offset = r.size;
        retries = 0;
      } catch (e) {
        // server holds a different byte count (e.g. a response was lost) — resume from its size
        if (e instanceof ApiError && e.status === 409 && typeof e.body.size === "number") offset = e.body.size;
        else if (++retries > MAX_RETRIES) throw e;
        else await sleep(1000 * retries);
      }
      report(offset, "upload");
    }

    await api.post(`${base}/import-sessions/${session.id}/complete`);
    for (;;) {
      await sleep(1500);
      const s = await api.get<{ state: string; result: ImportStats | null; error: string | null }>(
        `${base}/import-sessions/${session.id}`);
      if (s.state === "failed") throw new Error(s.error || `${file.name} could not be imported`);
      if (s.state === "done" && s.result) {
        total.imported += s.result.imported;
        total.skipped += s.result.skipped;
        total.failed += s.result.failed;
        break;
      }
      report(file.size, "processing");
    }
  }
  return total;
}
