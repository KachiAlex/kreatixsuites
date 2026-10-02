import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { useAuth } from "../lib/auth";
import { getToken } from "../lib/api";
import { createCollabSession, type CollabSession } from "./session";

/** Create + own a collab session for a file (null until user resolves). */
export function useCollabSession(fileId: string | undefined): CollabSession | null {
  const { user } = useAuth();
  const [session, setSession] = useState<CollabSession | null>(null);
  const uid = user?.id;
  useEffect(() => {
    if (!user || !fileId || !getToken()) return;
    const s = createCollabSession(fileId, user);
    setSession(s);
    return () => { s.destroy(); setSession(null); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileId, uid]);
  return session;
}

/**
 * Sync a flat object collection (one JSON entry per object id) through a
 * Y.Map<string>. Remote applies flow through `apply`; `push` writes only the
 * dirty keys so echo-pushes after a remote apply are no-ops.
 */
export class MapSync {
  readonly map: Y.Map<string>;
  constructor(
    session: CollabSession,
    name: string,
    applyRef: React.MutableRefObject<(changed: Map<string, string | null>) => void>,
  ) {
    this.map = session.ydoc.getMap<string>(name);
    this.map.observe((e, tx) => {
      if (tx.local) return;
      const changed = new Map<string, string | null>();
      e.keysChanged.forEach((k) => changed.set(k, this.map.has(k) ? this.map.get(k)! : null));
      if (changed.size) applyRef.current(changed);
    });
  }

  /** Write the local keyset — sets dirty keys, deletes keys absent locally. */
  push(items: Map<string, string>) {
    this.map.doc!.transact(() => {
      for (const [k, v] of items) if (this.map.get(k) !== v) this.map.set(k, v);
      for (const k of [...this.map.keys()]) if (!items.has(k)) this.map.delete(k);
    });
  }

  /** Sparse update — set changed keys, delete nulls, leave other keys alone.
   *  Unlike `push`, this does not treat absent keys as deletions. */
  patch(items: Map<string, string | null>) {
    this.map.doc!.transact(() => {
      for (const [k, v] of items) {
        if (v === null) { if (this.map.has(k)) this.map.delete(k); }
        else if (this.map.get(k) !== v) this.map.set(k, v);
      }
    });
  }
}

/**
 * Ref-stable MapSync instance, recreated if the session is replaced.
 * `apply` is read through a ref so it never goes stale; pass the latest
 * closure each render via `applyRef.current = fn`.
 */
export function useMapSync(
  session: CollabSession | null,
  name: string,
  applyRef: React.MutableRefObject<(changed: Map<string, string | null>) => void>,
): MapSync | null {
  return useMemo(
    () => (session ? new MapSync(session, name, applyRef) : null),
    [session, name, applyRef],
  );
}
