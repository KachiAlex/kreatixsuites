import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useToast } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { Modal } from "../components/Modal";

// Kreatix Tasks — org-shared kanban (todo/doing/done). Cards carry assignee,
// due date and notes; drag between columns or use the status picker in the
// detail modal.

interface Task {
  id: string; title: string | null; notes: string | null; status: string;
  dueAt: string | null; position: number;
  assignee: { id: string; displayName: string | null; initials: string | null } | null;
  createdBy: string; createdByName: string | null; createdAt: string;
}
interface Person { id: string; displayName: string; email: string; initials: string }

const COLS: { key: string; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "doing", label: "In progress" },
  { key: "done", label: "Done" },
];

const fmtDue = (iso: string) => {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdue = d.getTime() < today.getTime();
  return {
    text: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    overdue,
  };
};

export function Tasks() {
  const { user } = useAuth();
  const { msg, toast } = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [detail, setDetail] = useState<Task | null>(null);
  const [creating, setCreating] = useState<string | null>(null); // column key
  const [people, setPeople] = useState<Person[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "mine">("all");
  // form
  const [fTitle, setFTitle] = useState("");
  const [fNotes, setFNotes] = useState("");
  const [fAssignee, setFAssignee] = useState("");
  const [fDue, setFDue] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ tasks: Task[] }>("/api/tasks");
      setTasks(r.tasks);
    } catch (e) { toast((e as Error).message); }
  }, [toast]);

  useEffect(() => {
    void load();
    void api.get<{ people: Person[] }>("/api/chat/people")
      .then((r) => setPeople(r.people)).catch(() => {});
  }, [load]);

  const openNew = (status: string) => {
    setDetail(null); setCreating(status);
    setFTitle(""); setFNotes(""); setFAssignee(""); setFDue("");
  };
  const openEdit = (t: Task) => {
    setCreating(null); setDetail(t);
    setFTitle(t.title ?? ""); setFNotes(t.notes ?? "");
    setFAssignee(t.assignee?.id ?? ""); setFDue(t.dueAt ? t.dueAt.slice(0, 10) : "");
  };

  const save = async () => {
    if (!fTitle.trim()) return;
    const body = {
      title: fTitle.trim(), notes: fNotes.trim() || "",
      assigneeId: fAssignee || null, dueAt: fDue ? new Date(`${fDue}T17:00:00`).toISOString() : null,
    };
    try {
      if (detail) await api.patch(`/api/tasks/${detail.id}`, body);
      else await api.post("/api/tasks", { ...body, status: creating ?? "todo" });
      setDetail(null); setCreating(null);
      void load();
    } catch (e) { toast((e as Error).message); }
  };

  const move = async (t: Task, status: string) => {
    if (t.status === status) return;
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, status } : x)));
    try { await api.patch(`/api/tasks/${t.id}`, { status }); }
    catch { void load(); }
  };

  const del = async (t: Task) => {
    try { await api.del(`/api/tasks/${t.id}`); setDetail(null); void load(); }
    catch (e) { toast((e as Error).message); }
  };

  const visible = filter === "mine"
    ? tasks.filter((t) => t.assignee?.id === user?.id || t.createdBy === user?.id)
    : tasks;

  return (
    <>
      <div className="crumbs">
        <b>Tasks</b><span className="d-sub" style={{ marginLeft: 8 }}>org board</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value as "all" | "mine")}>
            <option value="all">All tasks</option>
            <option value="mine">Assigned to me</option>
          </select>
        </div>
      </div>

      <div className="task-board">
        {COLS.map((col) => {
          const list = visible.filter((t) => t.status === col.key);
          return (
            <div key={col.key} className="task-col"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const t = tasks.find((x) => x.id === dragId);
                if (t) void move(t, col.key);
                setDragId(null);
              }}>
              <div className="task-col-h">
                <b>{col.label}</b><span className="task-count">{list.length}</span>
                <button className="iconbtn" title="Add task" onClick={() => openNew(col.key)}>＋</button>
              </div>
              {list.map((t) => {
                const due = t.dueAt ? fmtDue(t.dueAt) : null;
                return (
                  <button key={t.id} className={`task-card${t.status === "done" ? " done" : ""}`}
                    draggable onDragStart={() => setDragId(t.id)} onDragEnd={() => setDragId(null)}
                    onClick={() => openEdit(t)}>
                    <b>{t.title}</b>
                    {t.notes && <span className="task-notes">{t.notes.slice(0, 80)}</span>}
                    <span className="task-meta">
                      {t.assignee && <span className="chat-avatar" title={t.assignee.displayName ?? ""}>{t.assignee.initials}</span>}
                      {due && <span className={`task-due${due.overdue && t.status !== "done" ? " overdue" : ""}`}>◷ {due.text}</span>}
                    </span>
                  </button>
                );
              })}
              {!list.length && <div className="task-empty">No tasks</div>}
            </div>
          );
        })}
      </div>

      {(creating || detail) && (
        <Modal label={detail ? "Edit task" : "New task"} onClose={() => { setDetail(null); setCreating(null); }} style={{ width: 420 }}>
          <div className="ob-body">
            <input placeholder="Task title" value={fTitle} onChange={(e) => setFTitle(e.target.value)}
              style={{ width: "100%", marginBottom: 10 }} autoFocus
              onKeyDown={(e) => e.key === "Enter" && void save()} />
            <textarea placeholder="Notes (optional)" value={fNotes} onChange={(e) => setFNotes(e.target.value)}
              rows={3} style={{ width: "100%", marginBottom: 10 }} />
            <div className="cal-formrow">
              <label>Assignee
                <select value={fAssignee} onChange={(e) => setFAssignee(e.target.value)}>
                  <option value="">Unassigned</option>
                  <option value={user?.id}>{user?.displayName} (me)</option>
                  {people.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
                </select>
              </label>
              <label>Due
                <input type="date" value={fDue} onChange={(e) => setFDue(e.target.value)} />
              </label>
            </div>
            {detail && (
              <div className="cal-formrow" style={{ marginBottom: 0 }}>
                <label>Status
                  <select value={detail.status} onChange={(e) => void move(detail, e.target.value).then(load)}>
                    {COLS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
              </div>
            )}
            <div className="dlg-actions">
              {detail && (detail.createdBy === user?.id || user?.role === "owner" || user?.role === "admin") && (
                <button className="btn-ghost" onClick={() => void del(detail)}>Delete</button>
              )}
              <button className="btn-ghost" onClick={() => { setDetail(null); setCreating(null); }}>Cancel</button>
              <button className="btn-primary" disabled={!fTitle.trim()} onClick={() => void save()}>
                {detail ? "Save" : "Add task"}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {msg && <div className="toast" role="status">{msg}</div>}
    </>
  );
}
