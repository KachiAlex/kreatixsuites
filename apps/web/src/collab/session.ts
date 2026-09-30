// Collab session — Yjs doc + y-websocket provider + awareness presence.
// Local mutations go straight into the Y.Doc; the provider queues them while
// offline and reconciles on reconnect (CRDT merge — no lost writes).
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";
import { getToken } from "../lib/api";
import { API_BASE } from "../lib/platform";
import type { User } from "@kreatix/shared";

export const PEER_COLORS = ["#F2782E", "#3578E5", "#1F9D66", "#8E6BC8", "#D84B57", "#C2941B", "#0FA3A3", "#B3478C"];

export interface PeerUser { name: string; initials: string; color: string }
export type ConnStatus = "connecting" | "connected" | "disconnected";

export interface CollabSession {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  awareness: Awareness;
  user: PeerUser;
  /** merge fields into our awareness state (selection location, cursor…) */
  setLocal: (fields: Record<string, unknown>) => void;
  /** remote peers' awareness states (clientId → state incl. our `user` block) */
  peers: () => Map<number, Record<string, unknown>>;
  onPeers: (cb: () => void) => () => void;
  onStatus: (cb: (s: ConnStatus) => void) => () => void;
  whenSynced: Promise<void>;
  destroy: () => void;
}

export function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
}

export function createCollabSession(fileId: string, user: User): CollabSession {
  const ydoc = new Y.Doc();
  const wsBase = API_BASE
    ? `${API_BASE.replace(/^http/, "ws")}/api/collab`
    : `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/collab`;
  const provider = new WebsocketProvider(
    wsBase,
    fileId,
    ydoc,
    { params: { token: getToken() ?? "" } },
  );
  const peerUser: PeerUser = {
    name: user.displayName,
    initials: user.initials,
    color: colorFor(user.id),
  };
  provider.awareness.setLocalStateField("user", peerUser);

  const peers = () => {
    const m = new Map<number, Record<string, unknown>>();
    for (const [id, s] of provider.awareness.getStates()) {
      if (id !== provider.awareness.clientID) m.set(id, s as Record<string, unknown>);
    }
    return m;
  };

  const session: CollabSession = {
    ydoc,
    provider,
    awareness: provider.awareness,
    user: peerUser,
    setLocal: (fields) => {
      for (const [k, v] of Object.entries(fields)) provider.awareness.setLocalStateField(k, v);
    },
    peers,
    onPeers: (cb) => {
      provider.awareness.on("update", cb);
      return () => provider.awareness.off("update", cb);
    },
    onStatus: (cb) => {
      const onS = (e: { status: string }) => cb(e.status === "connected" ? "connected" : "disconnected");
      const onC = () => cb("connected");
      const onD = () => cb("disconnected");
      provider.on("status", onS);
      provider.on("sync", onC);
      provider.ws?.addEventListener("close", onD);
      return () => { provider.off("status", onS); provider.off("sync", onC); };
    },
    whenSynced: new Promise<void>((res) => {
      if (provider.synced) res();
      else provider.once("sync", () => res());
    }),
    destroy: () => provider.destroy(),
  };
  return session;
}
