import { useEffect, useState } from "react";
import type { CollabSession, ConnStatus, PeerUser } from "./session";

interface PeerState { user?: PeerUser; where?: { label: string } }

/** Avatar stack of live collaborators + connection status, for editor topbars. */
export function PresenceBar({ session }: { session: CollabSession | null }) {
  const [peers, setPeers] = useState<PeerState[]>([]);
  const [status, setStatus] = useState<ConnStatus>("connecting");

  useEffect(() => {
    if (!session) return;
    const upd = () => setPeers([...session.peers().values()] as PeerState[]);
    const offS = session.onStatus(setStatus);
    const offP = session.onPeers(upd);
    upd();
    return () => { offS(); offP(); };
  }, [session]);

  if (!session) return null;

  return (
    <div className="presence" title={peers.map((p) => p.user?.name).filter(Boolean).join(", ") || undefined}>
      <span className={`presence-dot ${status}`} />
      {peers.map((p, i) => (
        <span key={i} className="presence-av" style={{ background: p.user?.color ?? "#999" }}
          title={`${p.user?.name ?? "?"}${p.where ? ` — ${p.where.label}` : ""}`}>
          {p.user?.initials ?? "?"}
        </span>
      ))}
      {status !== "connected" && <span className="presence-label">{status}</span>}
    </div>
  );
}
