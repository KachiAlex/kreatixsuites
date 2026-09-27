// ⌘K command palette — fuzzy action/file launcher with content snippets.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DriveItem, FileKind } from "@kreatix/shared";
import { api } from "../lib/api";
import { createDoc } from "../lib/create";
import { KIND_META } from "../lib/format";

type SearchItem = DriveItem & { match?: "name" | "content"; snippet?: string };

interface Row {
  id: string;
  group: string;
  icon: string;
  iconCls?: string;
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
}

export function CommandPalette({ open, onClose, onTemplates, onUpload, toast }: {
  open: boolean;
  onClose: () => void;
  onTemplates: () => void;
  onUpload: () => void;
  toast: (m: string) => void;
}) {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchItem[]>([]);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) { setQ(""); setHits([]); setIdx(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  useEffect(() => {
    if (!open || !q.trim()) { setHits([]); return; }
    const t = setTimeout(async () => {
      try {
        const r = await api.get<{ items: SearchItem[] }>(`/api/search?q=${encodeURIComponent(q)}`);
        setHits(r.items);
      } catch { setHits([]); }
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  const actions: Row[] = useMemo(() => {
    const mk = (kind: Exclude<FileKind, "folder">) => async () => {
      try { const it = await createDoc(kind); navigate(`/edit/${it.id}`); }
      catch { toast("Could not create file"); }
    };
    const nav = (to: string, icon: string, label: string): Row => ({ id: `nav:${to}`, group: "Go to", icon, label, run: () => { navigate(to); } });
    return [
      { id: "a:writer", group: "Create", icon: "W", iconCls: "writer", label: "New Writer document", run: mk("writer") },
      { id: "a:sheets", group: "Create", icon: "S", iconCls: "sheets", label: "New Sheets workbook", run: mk("sheets") },
      { id: "a:present", group: "Create", icon: "P", iconCls: "present", label: "New Present deck", run: mk("present") },
      { id: "a:folder", group: "Create", icon: "▣", iconCls: "folder-ico", label: "New folder", run: async () => {
        try { await createDoc("folder"); navigate("/drive/all"); } catch { toast("Could not create folder"); }
      } },
      { id: "a:templates", group: "Create", icon: "❖", label: "Open template gallery…", run: () => onTemplates() },
      { id: "a:upload", group: "Create", icon: "↑", iconCls: "file-ico", label: "Upload file…", run: () => onUpload() },
      nav("/", "⌂", "Home"),
      nav("/drive", "◷", "Recent files"),
      nav("/drive/starred", "★", "Starred"),
      nav("/drive/all", "▣", "Kreatix Drive"),
      nav("/drive/shared", "⤴", "Shared with me"),
      nav("/drive/trash", "🗑", "Recycle bin"),
    ];
  }, [navigate, onTemplates, onUpload, toast]);

  const rows: Row[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    const acts = term
      ? actions.filter((a) => a.label.toLowerCase().includes(term))
      : actions;
    const files: Row[] = hits.map((h) => ({
      id: `f:${h.id}`, group: "Files", iconCls: h.kind,
      icon: KIND_META[h.kind]?.label?.[0] ?? "•",
      label: h.name,
      hint: h.match === "content" ? "content match" : undefined,
      run: () => { navigate(h.kind === "folder" ? `/drive/folder/${h.id}` : `/edit/${h.id}`); },
    }));
    return [...acts, ...files];
  }, [actions, hits, q, navigate]);

  const activeIdx = Math.min(idx, Math.max(0, rows.length - 1));

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = rows[activeIdx]; if (r) { onClose(); void r.run(); } }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${activeIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;
  let lastGroup = "";
  return (
    <div className="dlg-back palette-back" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="palette-input" placeholder="Search files, run a command…"
          value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey} />
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && <div className="empty" style={{ padding: 18 }}>No matches.</div>}
          {rows.map((r, i) => {
            const head = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <div key={r.id}>
                {head && <div className="palette-group">{head}</div>}
                <button data-i={i} className={`palette-row ${i === activeIdx ? "on" : ""}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => { onClose(); void r.run(); }}>
                  <span className={`cm-ico ${r.iconCls ?? ""}`}>{r.icon}</span>
                  <span className="palette-label">{r.label}</span>
                  {r.hint && <span className="palette-hint">{r.hint}</span>}
                  {(() => {
                    const snip = hits.find((h) => `f:${h.id}` === r.id)?.snippet;
                    return snip ? <span className="palette-snip">{renderSnippet(snip)}</span> : null;
                  })()}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot"><kbd>↑↓</kbd> navigate <kbd>↵</kbd> open <kbd>esc</kbd> close</div>
      </div>
    </div>
  );
}

/** FTS snippets arrive with « » markers — render them as <mark>. */
export function renderSnippet(s: string) {
  const parts = s.split(/«|»/);
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p));
}
