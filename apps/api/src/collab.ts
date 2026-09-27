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
import { db } from "./db.js";
import { permissionFor, hasPermission, type UserRow } from "./auth.js";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const SYNC_STEP1 = 0; // state vector exchange — read-only safe
const SYNC_STEP2 = 1; // carries update payload — write op
const SYNC_UPDATE = 2; // write op

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
  db.prepare(
    "INSERT INTO collab_states (file_id, state, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(file_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at",
  ).run(fileId, Buffer.from(Y.encodeStateAsUpdate(room.doc)));
}

function getRoom(fileId: string): Room {
  let room = rooms.get(fileId);
  if (room) return room;
  const doc = new Y.Doc();
  const row = db.prepare("SELECT state FROM collab_states WHERE file_id = ?").get(fileId) as { state: Buffer } | undefined;
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
      room!.saveTimer = setTimeout(() => { room!.saveTimer = null; persistRoom(fileId, room!); }, 2000);
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
    persistRoom(fileId, room);
    room.awareness.destroy();
    room.doc.destroy();
    rooms.delete(fileId);
  }
}

export async function collabRoutes(app: FastifyInstance) {
  app.get("/api/collab/:id", { websocket: true }, async (socket, req) => {
    const fileId = (req.params as { id: string }).id;
    const token = (req.query as { token?: string }).token ?? "";
    try {
      const { payload } = await jwtVerify(token, secret);
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(payload.sub) as UserRow | undefined;
      const item = db.prepare("SELECT id, owner_id FROM items WHERE id = ? AND trashed = 0").get(fileId) as { id: string; owner_id: string } | undefined;
      if (!user || !item) throw new Error("unauthorized");
      const perm = permissionFor(user.id, item);
      if (!hasPermission(perm, "viewer")) throw new Error("unauthorized");
      const canWrite = hasPermission(perm, "editor");

      const room = getRoom(fileId);
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

      socket.on("message", (raw: Buffer) => {
        const data = new Uint8Array(raw);
        const dec = decoding.createDecoder(data);
        const msgType = decoding.readVarUint(dec);
        if (msgType === MSG_SYNC) {
          // peek the sync sub-type with a second decoder — viewers may sync, never write
          const peek = decoding.createDecoder(data);
          decoding.readVarUint(peek);
          if (!canWrite && decoding.readVarUint(peek) !== SYNC_STEP1) return;
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
      });
      socket.on("close", () => closeConn(fileId, room, socket));
      socket.on("error", () => closeConn(fileId, room, socket));
    } catch {
      socket.close(4401, "unauthorized");
    }
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
