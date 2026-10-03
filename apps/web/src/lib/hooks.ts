// Shared data/UI hooks — kept in lib so page components stay splittable:
// importing useToast from a page would drag that page's whole import graph
// into every chunk that needs it.
import { useCallback, useEffect, useState } from "react";
import type { DriveItem } from "@kreatix/shared";
import { api } from "./api";

export function useFiles(view: string, parent?: string) {
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const qs = parent !== undefined ? `parent=${parent}` : `view=${view}`;
      const r = await api.get<{ items: DriveItem[] }>(`/api/drive?${qs}`);
      setItems(r.items);
    } finally {
      setLoading(false);
    }
  }, [view, parent]);
  useEffect(() => {
    refresh();
    const h = () => refresh();
    window.addEventListener("kreatix:refresh", h);
    return () => window.removeEventListener("kreatix:refresh", h);
  }, [refresh]);
  return { items, loading, refresh };
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  const toast = useCallback((m: string) => {
    setMsg(m);
    setTimeout(() => setMsg(null), 2600);
  }, []);
  return { msg, toast };
}

export function useItemActions(refresh: () => void) {
  const [sharing, setSharing] = useState<DriveItem | null>(null);
  const [versions, setVersions] = useState<DriveItem | null>(null);
  const { msg, toast } = useToast();
  return { sharing, setSharing, versions, setVersions, msg, toast, refresh };
}
