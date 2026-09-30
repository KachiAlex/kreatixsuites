import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { DriveItem } from "@kreatix/shared";
import { KIND_META } from "../lib/format";
import { AppIcon, BrandLockup } from "../components/AppIcon";

/** Public share-link landing page (KBS-SHARED-008) */
export function SharedLink() {
  const { token } = useParams();
  const [item, setItem] = useState<DriveItem | null>(null);
  const [perm, setPerm] = useState("");
  const [error, setError] = useState("");
  const [content, setContent] = useState<unknown>(null);

  useEffect(() => {
    fetch(`/api/links/${token}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).message ?? "Link unavailable");
        return r.json();
      })
      .then((d) => {
        setItem(d.item);
        setPerm(d.permission);
        if (d.item.mimeType?.startsWith("application/x-kreatix-") || d.item.kind === "writer") {
          return fetch(`/api/links/${token}/content`).then((r) => r.json()).then((c) => setContent(c.content));
        }
      })
      .catch((e) => setError(e.message));
  }, [token]);

  if (error) {
    return (
      <div className="auth-wrap">
        <div className="auth-card" style={{ textAlign: "center" }}>
          <BrandLockup size={44} style={{ margin: "0 auto 14px", width: "fit-content" }} />
          <h1>Link unavailable</h1>
          <p>{error}</p>
        </div>
      </div>
    );
  }
  if (!item) return <div className="auth-wrap"><div className="empty">Loading…</div></div>;

  const meta = KIND_META[item.kind] ?? KIND_META.file;
  const doc = (content as { doc?: { content?: { type: string; content?: { type: string; text?: string }[] }[] } })?.doc;

  return (
    <div className="auth-wrap" style={{ alignItems: "start" }}>
      <div style={{ width: "min(860px, 100%)", marginTop: 30 }}>
        <div className="crumbs" style={{ justifyContent: "center", marginBottom: 18 }}>
          <span className="perm-badge">{perm} access via link</span>
        </div>
        <div className="file" style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 16 }}>
          <div className={`thumb ${meta.cls}`}><AppIcon kind={item.kind} /></div>
          <div><h4>{item.name}</h4><p>{meta.label} · shared publicly</p></div>
          <div />
          <div />
          <div />
        </div>
        {doc && (
          <div className="doc-page" style={{ marginTop: 18, minHeight: 400 }}>
            {(doc.content ?? []).map((n, i) => (
              <p key={i}>{(n.content ?? []).map((t, j) => <span key={j}>{t.text}</span>)}</p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
