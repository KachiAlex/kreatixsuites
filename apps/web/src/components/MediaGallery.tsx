import { useEffect, useState } from "react";
import type { DriveItem } from "@kreatix/shared";
import { mediaUrl } from "../lib/api";
import { KIND_META, timeAgo } from "../lib/format";
import { AppIcon } from "./AppIcon";

const isImage = (it: DriveItem) => it.mimeType?.startsWith("image/");
const isVideo = (it: DriveItem) => it.mimeType?.startsWith("video/");

/** Thumbnail gallery for 'media' libraries — image/video cards with a
 *  lightbox; folders and non-visual files keep icon tiles. */
export function MediaGallery({ items, onOpen, toast }: {
  items: DriveItem[];
  onOpen: (item: DriveItem) => void;
  toast: (m: string) => void;
}) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const visuals = items.filter((i) => isImage(i) || isVideo(i));

  useEffect(() => {
    if (lightbox === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
      if (e.key === "ArrowRight") setLightbox((l) => l === null ? null : Math.min(l + 1, visuals.length - 1));
      if (e.key === "ArrowLeft") setLightbox((l) => l === null ? null : Math.max(l - 1, 0));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox, visuals.length]);

  if (!items.length) return <div className="panel"><div className="empty">Nothing here yet — drag media files in.</div></div>;

  const current = lightbox === null ? null : visuals[lightbox];

  return (
    <>
      <div className="media-grid">
        {items.map((it) => {
          const meta = KIND_META[it.kind] ?? KIND_META.file;
          const vi = visuals.indexOf(it);
          return (
            <button key={it.id} className="media-card"
              onClick={() => vi >= 0 ? setLightbox(vi) : onOpen(it)}
              title={it.name}>
              {isImage(it) ? (
                <img src={mediaUrl(`/api/files/${it.id}/raw?w=420`)} alt={it.name} loading="lazy"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }} />
              ) : isVideo(it) ? (
                <video src={mediaUrl(`/api/files/${it.id}/raw`)} muted preload="metadata" />
              ) : (
                <span className={`thumb ${meta.cls}`}><AppIcon kind={it.kind} /></span>
              )}
              <span className="media-card-name">
                {it.name}
                <small>{it.kind === "folder" ? "folder" : timeAgo(it.updatedAt)}</small>
              </span>
              {it.starred && <span className="media-card-star">★</span>}
            </button>
          );
        })}
      </div>

      {current && (
        <div className="lightbox" role="dialog" aria-label={current.name} onClick={() => setLightbox(null)}>
          <button className="lightbox-x" aria-label="Close">✕</button>
          {lightbox! > 0 && (
            <button className="lightbox-nav prev" aria-label="Previous"
              onClick={(e) => { e.stopPropagation(); setLightbox(lightbox! - 1); }}>‹</button>
          )}
          {isVideo(current) ? (
            <video src={mediaUrl(`/api/files/${current.id}/raw`)} controls autoPlay
              onClick={(e) => e.stopPropagation()} />
          ) : (
            <img src={mediaUrl(`/api/files/${current.id}/raw`)} alt={current.name}
              onClick={(e) => e.stopPropagation()} />
          )}
          <div className="lightbox-cap" onClick={(e) => e.stopPropagation()}>
            {current.name}
            <button className="btn-ghost btn-sm" style={{ marginLeft: 12 }}
              onClick={() => { setLightbox(null); onOpen(current); }}>Open file</button>
            <button className="btn-ghost btn-sm"
              onClick={() => { void navigator.clipboard?.writeText(current.name); toast("Name copied"); }}>Copy name</button>
          </div>
          {lightbox! < visuals.length - 1 && (
            <button className="lightbox-nav next" aria-label="Next"
              onClick={(e) => { e.stopPropagation(); setLightbox(lightbox! + 1); }}>›</button>
          )}
        </div>
      )}
    </>
  );
}
