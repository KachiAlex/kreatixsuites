// Image derivatives — lazily generated resized variants of image blobs.
// /content?w= snaps the request to the size ladder; the first request for a
// (source_key, width) pair transcodes with sharp, stores the result as a
// regular blob (content-addressed → dedup + S3 mirror for free), and records
// it in image_derivatives so subsequent serves are pure cache hits.
import sharp from "sharp";
import { one, run } from "./db.js";
import { getBlob, putBlob } from "./blobs.js";

const LADDER = [480, 960, 1920] as const;
const RASTER = /^image\/(jpeg|png|webp|avif|gif|tiff)$/i;

export const isRasterImage = (mime: string) => RASTER.test(mime);

/** Snap a requested width to the nearest ladder rung ≥ the request. */
export function snapWidth(requested: number): number | null {
  for (const w of LADDER) if (requested <= w) return w;
  return null; // larger than the biggest rung → serve the original
}

interface DerivRow { derivative_key: string; mime: string }

/** Look up (or lazily create) the derivative for (sourceKey, width). */
export async function derivativeFor(
  sourceKey: string,
  source: Buffer,
  mime: string,
  width: number,
): Promise<{ key: string; mime: string; buf: Buffer } | null> {
  const cached = await one<DerivRow>(
    "SELECT derivative_key, mime FROM image_derivatives WHERE source_key=$1 AND width=$2",
    [sourceKey, width],
  );
  if (cached) {
    const blob = await getBlob(cached.derivative_key);
    return blob ? { key: cached.derivative_key, mime: cached.mime, buf: blob } : null;
  }

  let out: Buffer;
  try {
    out = await sharp(source, { animated: mime === "image/gif" })
      .rotate() // honor EXIF orientation before any crop math
      .resize({ width, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch {
    return null; // not actually a raster (mime lied) — caller serves original
  }
  const { key } = await putBlob(out);
  await run(
    `INSERT INTO image_derivatives (source_key, width, derivative_key, mime)
     VALUES ($1,$2,$3,'image/webp')
     ON CONFLICT (source_key, width) DO NOTHING`,
    [sourceKey, width, key],
  );
  return { key, mime: "image/webp", buf: out };
}

/** Serve the best derivative for a requested width; null → use the original. */
export async function derivativeBlob(
  sourceKey: string,
  source: Buffer,
  mime: string,
  requestedW: number | undefined,
): Promise<{ blob: Buffer; mime: string; key: string }> {
  if (!requestedW || !isRasterImage(mime)) return { blob: source, mime, key: sourceKey };
  const w = snapWidth(requestedW);
  if (!w) return { blob: source, mime, key: sourceKey };
  const d = await derivativeFor(sourceKey, source, mime, w);
  if (!d) return { blob: source, mime, key: sourceKey };
  return { blob: d.buf, mime: d.mime, key: d.key };
}
