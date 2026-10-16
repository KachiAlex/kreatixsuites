// Shared data/UI hooks — kept in lib so page components stay splittable:
// importing useToast from a page would drag that page's whole import graph
// into every chunk that needs it.
import { useCallback, useEffect, useState } from "react";
import type { DriveItem, Site } from "@kreatix/shared";
import { api } from "./api";

export function useFiles(view: string, parent?: string, library?: string) {
  const [items, setItems] = useState<DriveItem[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const qs = parent !== undefined ? `parent=${parent}` : library ? `library=${library}` : `view=${view}`;
      const r = await api.get<{ items: DriveItem[] }>(`/api/drive?${qs}`);
      setItems(r.items);
    } finally {
      setLoading(false);
    }
  }, [view, parent, library]);
  useEffect(() => {
    refresh();
    const h = () => refresh();
    window.addEventListener("kreatix:refresh", h);
    return () => window.removeEventListener("kreatix:refresh", h);
  }, [refresh]);
  return { items, loading, refresh };
}

export function useSites() {
  const [sites, setSites] = useState<Site[]>([]);
  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ sites: Site[] }>("/api/sites");
      setSites(r.sites);
    } catch { /* sidebar degrades silently */ }
  }, []);
  useEffect(() => {
    void refresh();
    const h = () => void refresh();
    window.addEventListener("kreatix:refresh", h);
    window.addEventListener("kreatix:sites", h);
    return () => { window.removeEventListener("kreatix:refresh", h); window.removeEventListener("kreatix:sites", h); };
  }, [refresh]);
  return { sites, refresh };
}

/** True when the server has Kreatix Mail wired up — gates the Mail nav entry. */
export function useMailEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    api.get<{ enabled: boolean }>("/api/mail/status")
      .then((r) => setEnabled(!!r.enabled))
      .catch(() => {});
  }, []);
  return enabled;
}

/** True when the server has Kreatix Meet wired up — gates the Meet nav entry. */
export function useMeetEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    api.get<{ enabled: boolean }>("/api/meet/status")
      .then((r) => setEnabled(!!r.enabled))
      .catch(() => {});
  }, []);
  return enabled;
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
