// Real-time collab rooms: y-websocket wire protocol (sync + awareness) over
// @fastify/websocket. One Y.Doc per file; CRDT state persisted to SQLite so
// live sessions survive restarts. Canonical JSON content still flows through
// the normal autosave/version pipeline.
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { jwtVerify } from "jose";
import type { FastifyInstance } from "fastify";

// structural subset of ws.WebSocket we use — avoids a hard dep on `ws` types
const WS_OPEN = 1;
interface WebSocket {
  readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: never[]) => void): void;
}
import { one, run } from "./db.js";
import { permissionFor, hasPermission, type UserRow } from "./auth.js";
import { ensureSubscription, effectiveState } from "./billing.js";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SYNC_STEP1 = 0; // state vector exchange — read-only safe
const SYNC_STEP2 = 1; // carries update payload — write op
const SYNC_UPDATE = 2; // write op

const COMMENT_MARK = "commentMark";

// ---- commenter gate: only commentMark anchor changes may pass ----
// Canonical serialization of the doc's XmlFragment with commentMark attributes
// stripped and adjacent same-mark text runs merged — two docs that differ only
// in comment anchors serialize identically.

// stable stringify — JSON.stringify's array replacer filters keys at *every*
// nesting level, so nested attr objects need explicit key sorting
const stable = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
};

const canonMarks = (attrs: Record<string, unknown> | undefined): string => {
  if (!attrs) return "";
  return Object.keys(attrs)
    .filter((k) => k !== COMMENT_MARK)
    .sort()
    .map((k) => `${k}=${stable(attrs[k])}`)
    .join(",");
};

const canonXml = (node: Y.XmlFragment | Y.XmlElement, out: string[]): void => {
  for (let i = 0; i < node.length; i++) {
    const item = node.get(i);
    if (item instanceof Y.XmlText) {
      let run = "", runMarks: string | null = null;
      for (const op of item.toDelta() as { insert: unknown; attributes?: Record<string, unknown> }[]) {
        const marks = canonMarks(op.attributes);
        const text = typeof op.insert === "string" ? op.insert : stable(op.insert);
        if (runMarks === marks) { run += text; continue; }
        if (runMarks !== null) out.push(`(${runMarks})${run}`);
        runMarks = marks; run = text;
      }
      if (runMarks !== null) out.push(`(${runMarks})${run}`);
    } else if (item instanceof Y.XmlElement) {
      out.push(`<${item.nodeName} ${stable(item.getAttributes())}>`);
      canonXml(item, out);
      out.push("</>");
    }
  }
};

const canonical = (doc: Y.Doc): string => {
  const out: string[] = [];
  canonXml(doc.getXmlFragment("default"), out);
  return out.join("");
};

/** Apply `update` to a shadow clone of `doc` — returns true when the only
 *  change is added/removed commentMark anchors. Commenter writes are rare,
 *  so an O(doc) shadow diff is acceptable. */
const updateIsCommentMarkOnly = (doc: Y.Doc, update: Uint8Array): boolean => {
  try {
    const before = canonical(doc);
    const shadow = new Y.Doc();
    try {
      Y.applyUpdate(shadow, Y.encodeStateAsUpdate(doc));
      Y.applyUpdate(shadow, update);
      return canonical(shadow) === before;
    } finally {
      shadow.destroy();
    }
  } catch {
    return false;
  }
};

const secret = new TextEncoder().encode(
  process.env.JWT_SECRET ?? "kreatix-dev-secret-change-in-production",
);

interface Room {
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  conns: Map<WebSocket, Set<number>>; // socket → awareness client ids it controls
  saveTimer: NodeJS.Timeout | null;
}
const rooms = new Map<string, Room>();

/** Live collab room count (observability). */
export const activeCollabRooms = () => rooms.size;
export const collabPeers = () => {
  let n = 0;
  for (const r of rooms.values()) n += r.conns.size;
  return n;
};

const send = (ws: WebSocket, enc: encoding.Encoder) => {
  if (ws.readyState === WS_OPEN) ws.send(encoding.toUint8Array(enc));
};

function persistRoom(fileId: string, room: Room) {
  return run(
    "INSERT INTO collab_states (file_id, state, updated_at) VALUES ($1, $2, now()) " +
    "ON CONFLICT(file_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
    [fileId, Buffer.from(Y.encodeStateAsUpdate(room.doc))],
  );
}

async function getRoom(fileId: string): Promise<Room> {
  let room = rooms.get(fileId);
  if (room) return room;
  const doc = new Y.Doc();
  const row = await one<{ state: Buffer }>("SELECT state FROM collab_states WHERE file_id = $1", [fileId]);
  if (row?.state) Y.applyUpdate(doc, new Uint8Array(row.state));
  room = { doc, awareness: new awarenessProtocol.Awareness(doc), conns: new Map(), saveTimer: null };
  rooms.set(fileId, room);

  // broadcast doc updates to every conn + schedule persistence
  doc.on("update", (update: Uint8Array) => {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    const buf = encoding.toUint8Array(enc);
    for (const ws of room!.conns.keys()) if (ws.readyState === WS_OPEN) ws.send(buf);
    if (!room!.saveTimer) {
      room!.saveTimer = setTimeout(() => {
        room!.saveTimer = null;
        void persistRoom(fileId, room!).catch(() => {});
      }, 2000);
    }
  });

  // broadcast awareness changes to every conn except the originator
  room.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: WebSocket) => {
    const changed = [...added, ...updated, ...removed];
    if (!changed.length) return;
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room!.awareness, changed));
    const buf = encoding.toUint8Array(enc);
    for (const ws of room!.conns.keys()) if (ws !== origin && ws.readyState === WS_OPEN) ws.send(buf);
  });
  return room;
}

function closeConn(fileId: string, room: Room, ws: WebSocket) {
  const controlled = room.conns.get(ws);
  room.conns.delete(ws);
  if (controlled?.size) {
    awarenessProtocol.removeAwarenessStates(room.awareness, [...controlled], null);
  }
  if (!room.conns.size && rooms.get(fileId) === room) {
    if (room.saveTimer) clearTimeout(room.saveTimer);
    void persistRoom(fileId, room).catch(() => {});
    room.awareness.destroy();
    room.doc.destroy();
    rooms.delete(fileId);
  }
}

export async function collabRoutes(app: FastifyInstance) {
  app.get("/api/collab/:id", { websocket: true }, (socket, req) => {
    const fileId = (req.params as { id: string }).id;
    const token = (req.query as { token?: string }).token ?? "";
    // ws is a plain EventEmitter — 'message' events emitted before a listener
    // attaches are lost, and auth/room init below is async, so the client's
    // sync step1 (sent immediately on open) can race the handler. Buffer
    // everything from the start and drain once the real handler is wired.
    const pending: Buffer[] = [];
    let handler: ((raw: Buffer) => void) | null = null;
    socket.on("message", (raw: Buffer) => {
      if (handler) handler(raw);
      else pending.push(raw);
    });
    void (async () => {
      try {
        const { payload } = await jwtVerify(token, secret);
        const user = await one<UserRow>("SELECT * FROM users WHERE id = $1", [payload.sub as string]);
        const item = await one<{ id: string; owner_id: string }>(
          "SELECT id, owner_id FROM items WHERE id = $1 AND trashed = false",
          [fileId],
        );
        if (!user || !item || user.disabled) throw new Error("unauthorized");
        const perm = await permissionFor(user.id, item);
        if (!hasPermission(perm, "viewer")) throw new Error("unauthorized");
        // locked subscriptions still get the read-only sync handshake;
        // write payloads are rejected below like a viewer's
        const subState = effectiveState(await ensureSubscription(user.org_id)).state;
        const subLocked = subState === "locked";
        // reviewers+ write freely (suggestions are tracked client-side);
        // commenters may only push updates that change comment anchors;
        // viewers are read-only (sync step1 handshake only)
        const canWrite = hasPermission(perm, "reviewer") && !subLocked;
        const canAnchor = hasPermission(perm, "commenter");

        const room = await getRoom(fileId);
        room.conns.set(socket, new Set());

        // kick off the sync handshake: our state vector + existing awareness states
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        syncProtocol.writeSyncStep1(enc, room.doc);
        send(socket, enc);
        const states = room.awareness.getStates();
        if (states.size) {
          const encAw = encoding.createEncoder();
          encoding.writeVarUint(encAw, MSG_AWARENESS);
          encoding.writeVarUint8Array(encAw, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
          send(socket, encAw);
        }

        handler = (raw: Buffer) => {
          const data = new Uint8Array(raw);
          const dec = decoding.createDecoder(data);
          const msgType = decoding.readVarUint(dec);
          if (msgType === MSG_SYNC) {
            // peek the sync sub-type with a second decoder — step1 is a
            // read-only handshake; step2/update carry a write payload
            const peek = decoding.createDecoder(data);
            decoding.readVarUint(peek);
            const subtype = decoding.readVarUint(peek);
            if (subtype !== SYNC_STEP1 && !canWrite) {
              if (!canAnchor) return;
              // commenters: apply the update to a shadow doc and accept only
              // when it changes nothing but commentMark anchors
              try {
                decoding.readVarUint(dec); // consume the sync subtype byte
                const update = decoding.readVarUint8Array(dec);
                if (updateIsCommentMarkOnly(room.doc, update)) {
                  Y.applyUpdate(room.doc, update, socket);
                }
              } catch { /* malformed update — drop */ }
              return;
            }
            const enc = encoding.createEncoder();
            encoding.writeVarUint(enc, MSG_SYNC);
            syncProtocol.readSyncMessage(dec, enc, room.doc, socket);
            if (encoding.length(enc) > 1) send(socket, enc);
          } else if (msgType === MSG_AWARENESS) {
            const update = decoding.readVarUint8Array(dec);
            const owned = room.conns.get(socket);
            if (owned) for (const c of clientIdsInUpdate(update)) owned.add(c);
            awarenessProtocol.applyAwarenessUpdate(room.awareness, update, socket);
          }
        };
        for (const raw of pending) handler(raw);
        pending.length = 0;
        if (socket.readyState !== WS_OPEN) {
          closeConn(fileId, room, socket); // closed while init was in flight
        } else {
          socket.on("close", () => closeConn(fileId, room, socket));
          socket.on("error", () => closeConn(fileId, room, socket));
        }
      } catch {
        socket.close(4401, "unauthorized");
      }
    })();
  });
}

/** Peek at the client ids inside an awareness update (same encoding the client sent). */
function clientIdsInUpdate(update: Uint8Array): number[] {
  const ids: number[] = [];
  try {
    const dec = decoding.createDecoder(update);
    const len = decoding.readVarUint(dec);
    for (let i = 0; i < len; i++) {
      ids.push(decoding.readVarUint(dec));
      decoding.readVarUint(dec); // clock
      decoding.readVarString(dec); // state json
    }
  } catch { /* malformed — ignore */ }
  return ids;
}

// SYNC_STEP2/SYNC_UPDATE are write-bearing; kept for readability of the check above
void SYNC_STEP2;
void SYNC_UPDATE;
