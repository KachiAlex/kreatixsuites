import { useCallback, useEffect, useState } from "react";
import type { DriveItem, FileShare, ShareLink } from "@kreatix/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { PUBLIC_ORIGIN } from "../lib/platform";
import { Modal } from "./Modal";

export function ShareDialog({ item, onClose, toast }: {
  item: DriveItem; onClose: () => void; toast: (m: string) => void;
}) {
  const [shares, setShares] = useState<FileShare[]>([]);
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [email, setEmail] = useState("");
  const [perm, setPerm] = useState("viewer");
  const [linkPerm, setLinkPerm] = useState<"viewer" | "commenter" | "editor">("viewer");
  const [newLink, setNewLink] = useState<string | null>(null);
  const { hasFeature } = useAuth();
  const canProtect = hasFeature("share_protect");
  const [linkPw, setLinkPw] = useState("");
  const [linkDays, setLinkDays] = useState("");

  const load = useCallback(async () => {
    const [s, l] = await Promise.all([
      api.get<{ shares: FileShare[] }>(`/api/files/${item.id}/shares`),
      api.get<{ links: ShareLink[] }>(`/api/files/${item.id}/links`),
    ]);
    setShares(s.shares);
    setLinks(l.links);
  }, [item.id]);
  useEffect(() => { load().catch(() => {}); }, [load]);

  const addShare = async () => {
    try {
      await api.post(`/api/files/${item.id}/shares`, { email, permission: perm });
      setEmail("");
      toast(`Shared with ${email}`);
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Share failed");
    }
  };

  const createLink = async () => {
    try {
      const days = parseInt(linkDays, 10);
      const r = await api.post<{ link: ShareLink; url: string }>(`/api/files/${item.id}/links`, {
        permission: linkPerm,
        password: canProtect && linkPw ? linkPw : undefined,
        expiresAt: canProtect && days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : undefined,
      });
      setNewLink(`${PUBLIC_ORIGIN}${r.url}`);
      setLinkPw(""); setLinkDays("");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not create link");
    }
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast("Link copied");
  };

  return (
    <Modal onClose={onClose} label={`Share ${item.name}`}>
        <h2>Share "{item.name}"</h2>
        <p className="d-sub">Invite people or create a share link. Permissions follow view / review / edit modes.</p>

        <div className="field">
          <label>People</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addShare()} style={{ flex: 1 }} />
            <select value={perm} onChange={(e) => setPerm(e.target.value)}>
              <option value="viewer">Viewer</option>
              <option value="commenter">Commenter</option>
              <option value="reviewer">Reviewer</option>
              <option value="editor">Editor</option>
            </select>
            <button className="btn-primary btn-sm" onClick={addShare}>Share</button>
          </div>
        </div>

        {shares.map((s) => (
          <div className="share-row" key={s.id}>
            <div className="c-av">{s.user?.initials}</div>
            <div><b>{s.user?.displayName}</b><small>{s.user?.email}</small></div>
            <span className="perm-badge" style={{ marginLeft: "auto" }}>{s.permission}</span>
            <button className="x" onClick={async () => { await api.del(`/api/files/${item.id}/shares/${s.userId}`); load(); }}>✕</button>
          </div>
        ))}

        <div className="field" style={{ marginTop: 18 }}>
          <label>Share link</label>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={linkPerm} onChange={(e) => setLinkPerm(e.target.value as never)}>
              <option value="viewer">Anyone can view</option>
              <option value="commenter">Anyone can comment</option>
              <option value="editor">Anyone can edit</option>
            </select>
            <button className="btn-ghost btn-sm" onClick={createLink}>Create link</button>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
            <input type="password" placeholder={canProtect ? "Password (optional)" : "Password — Pro"}
              value={linkPw} onChange={(e) => setLinkPw(e.target.value)}
              disabled={!canProtect} style={{ flex: 1 }}
              title={canProtect ? "Require this password to open the link" : "Password-protected links need a paid plan"} />
            <input type="number" min={1} placeholder={canProtect ? "Expires in days" : "Expiry — Pro"}
              value={linkDays} onChange={(e) => setLinkDays(e.target.value)}
              disabled={!canProtect} style={{ width: 130 }}
              title={canProtect ? "Link stops working after this many days" : "Expiring links need a paid plan"} />
          </div>
          {!canProtect && (
            <small className="d-sub" style={{ marginTop: 4, display: "block" }}>
              Password and expiry protection are included in paid plans — upgrade in Admin → Billing.
            </small>
          )}
        </div>

        {newLink && (
          <div className="link-box">
            <code>{newLink}</code>
            <button className="btn-ghost btn-sm" onClick={() => copy(newLink)}>Copy</button>
          </div>
        )}
        {links.map((l) => (
          <div className="link-box" key={l.id} style={{ marginTop: 6 }}>
            <code>{PUBLIC_ORIGIN}/shared/{l.token}</code>
            <span className="perm-badge">{l.permission}</span>
            <button className="btn-ghost btn-sm" onClick={() => copy(`${PUBLIC_ORIGIN}/shared/${l.token}`)}>Copy</button>
            <button className="x" onClick={async () => { await api.del(`/api/files/${item.id}/links/${l.id}`); load(); }}>✕</button>
          </div>
        ))}

        <div className="d-actions">
          <button className="btn-ghost" onClick={onClose}>Done</button>
        </div>
    </Modal>
  );
}
