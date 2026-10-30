// ⌘K command palette — fuzzy action/file launcher with content snippets.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openAppPath } from "../lib/openApp";
import type { DriveItem, FileKind } from "@kreatix/shared";
import { api } from "../lib/api";
import { createDoc } from "../lib/create";
import { KIND_META } from "../lib/format";
import { AppIcon } from "./AppIcon";

const KIND_ICON = new Set(["writer", "sheets", "present", "pdf", "file", "folder"]);
const iconKind = (cls?: string) =>
  cls ? cls.replace(/-ico$/, "") : "";
const isKindIcon = (cls?: string) => KIND_ICON.has(iconKind(cls));

type SearchItem = DriveItem & { match?: "name" | "content"; snippet?: string };
interface AllResults {
  chats: { id: string; channelId: string; channel: string; author: string | null; snippet: string; createdAt: string }[];
  events: { id: string; title: string | null; startsAt: string; meetingId: string | null }[];
  meetings: { id: string; code: string; title: string; status: string; scheduledAt: string | null }[];
  people: { id: string; displayName: string; email: string; initials: string }[];
  mails: { id: number; subject: string; from: string; date: string | null }[];
  tasks?: { id: string; title: string | null; status: string; dueAt: string | null }[];
  forms?: { id: string; title: string | null }[];
  notes?: { id: string; title: string | null; snippet?: string }[];
}

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
  const [all, setAll] = useState<AllResults | null>(null);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) { setQ(""); setHits([]); setAll(null); setIdx(0); setTimeout(() => inputRef.current?.focus(), 0); }
  }, [open]);

  useEffect(() => {
    if (!open || !q.trim()) { setHits([]); setAll(null); return; }
    const t = setTimeout(async () => {
      try {
        const [files, rest] = await Promise.all([
          api.get<{ items: SearchItem[] }>(`/api/search?q=${encodeURIComponent(q)}`),
          api.get<AllResults>(`/api/search/all?q=${encodeURIComponent(q)}`).catch(() => null),
        ]);
        setHits(files.items);
        setAll(rest);
      } catch { setHits([]); setAll(null); }
    }, 180);
    return () => clearTimeout(t);
  }, [q, open]);

  const actions: Row[] = useMemo(() => {
    const mk = (kind: Exclude<FileKind, "folder">) => async () => {
      try { const it = await createDoc(kind); navigate(`/edit/${it.id}`); }
      catch { toast("Could not create file"); }
    };
    const nav = (to: string, icon: string, label: string): Row => ({ id: `nav:${to}`, group: "Go to", icon, label, run: () => { openAppPath(to, navigate); } });
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
      nav("/drive/all", "▣", "Drive"),
      nav("/drive/shared", "⤴", "Shared with me"),
      nav("/drive/trash", "🗑", "Recycle bin"),
      nav("/chat", "💬", "Chat"),
      nav("/calendar", "📅", "Calendar"),
      nav("/tasks", "✓", "Tasks"),
      nav("/notes", "📝", "Notes"),
      nav("/forms", "▤", "Forms"),
      nav("/meet", "▶", "Meet"),
      nav("/mail", "✉", "Envora"),
      nav("/sites", "◈", "Sites"),
      nav("/admin", "⚙", "Admin"),
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
    const rest: Row[] = (all?.people ?? []).map((p) => ({
      id: `p:${p.id}`, group: "People", icon: p.initials || "?", label: p.displayName,
      hint: p.email,
      run: () => { navigate(`/chat?dm=${p.id}`); },
    })).concat((all?.chats ?? []).map((m) => ({
      id: `c:${m.id}`, group: "Messages", iconCls: "chat", icon: "C",
      label: `${m.author ?? "?"} — ${m.channel}`,
      hint: "chat",
      run: () => { navigate(`/chat?c=${m.channelId}`); },
    })), (all?.events ?? []).map((e) => ({
      id: `e:${e.id}`, group: "Events", iconCls: "calendar", icon: "E",
      label: e.title ?? "Event",
      hint: new Date(e.startsAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      run: () => { navigate(`/calendar?e=${e.id}`); },
    })), (all?.meetings ?? []).map((m) => ({
      id: `m:${m.id}`, group: "Meetings", iconCls: "meet", icon: "M",
      label: m.title, hint: m.status,
      run: () => { navigate(m.status === "ended" ? "/meet" : `/meet?join=${m.id}`); },
    })), (all?.tasks ?? []).map((t) => ({
      id: `t:${t.id}`, group: "Tasks", iconCls: "tasks", icon: "T",
      label: t.title ?? "Task",
      hint: t.dueAt ? `due ${new Date(t.dueAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : t.status,
      run: () => { navigate("/tasks"); },
    })), (all?.forms ?? []).map((f) => ({
      id: `fm:${f.id}`, group: "Forms", iconCls: "forms", icon: "F",
      label: f.title ?? "Form", hint: "form",
      run: () => { navigate("/forms"); },
    })), (all?.notes ?? []).map((n) => ({
      id: `n:${n.id}`, group: "Notes", iconCls: "notes", icon: "N",
      label: n.title ?? "Page", hint: n.snippet ?? "note",
      run: () => { navigate("/notes"); },
    })), (all?.mails ?? []).map((m) => ({
      id: `ml:${m.id}`, group: "Envora", iconCls: "mail", icon: "✉",
      label: m.subject, hint: m.from,
      run: () => { navigate("/mail"); },
    })));
    return [...acts, ...files, ...rest];
  }, [actions, hits, all, q, navigate]);

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
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={inputRef} className="palette-input" placeholder="Search files, run a command…"
          aria-label="Search files and commands" aria-expanded="true" role="combobox" aria-controls="palette-list"
          value={q} onChange={(e) => { setQ(e.target.value); setIdx(0); }} onKeyDown={onKey} />
        <div className="palette-list" ref={listRef} id="palette-list" role="listbox">
          {rows.length === 0 && <div className="empty" style={{ padding: 18 }}>No matches.</div>}
          {rows.map((r, i) => {
            const head = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              <div key={r.id}>
                {head && <div className="palette-group">{head}</div>}
                <button data-i={i} role="option" aria-selected={i === activeIdx}
                  className={`palette-row ${i === activeIdx ? "on" : ""}`}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => { onClose(); void r.run(); }}>
                  <span className={`cm-ico ${r.iconCls ?? ""}`}>
                    {isKindIcon(r.iconCls) ? <AppIcon kind={iconKind(r.iconCls)} /> : r.icon}
                  </span>
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
