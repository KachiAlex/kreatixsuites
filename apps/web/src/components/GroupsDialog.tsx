import { useEffect, useState } from "react";
import type { OrgGroup } from "@kreatix/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Modal } from "./Modal";

/** Org group manager (SharePoint groups) — named sets of people that site and
 *  library owners can grant access to as a unit. Workspace admins manage
 *  membership; everyone can see the roster for grant pickers. */
export function GroupsDialog({ onClose, toast }: { onClose: () => void; toast: (m: string) => void }) {
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const [groups, setGroups] = useState<OrgGroup[]>([]);
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, NonNullable<OrgGroup["members"]>>>({});
  const [memberEmail, setMemberEmail] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const r = await api.get<{ groups: OrgGroup[] }>("/api/groups");
    setGroups(r.groups);
  };
  useEffect(() => { void load().catch(() => {}); }, []);

  const loadMembers = async (gid: string) => {
    const r = await api.get<{ members: NonNullable<OrgGroup["members"]> }>(`/api/groups/${gid}/members`);
    setMembers((m) => ({ ...m, [gid]: r.members }));
  };

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await api.post("/api/groups", { name: name.trim(), description: desc.trim() || null });
      setName(""); setDesc("");
      await load();
      toast("Group created");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
    setBusy(false);
  };

  const addMember = async (gid: string) => {
    if (!memberEmail.trim()) return;
    try {
      await api.post(`/api/groups/${gid}/members`, { email: memberEmail.trim() });
      setMemberEmail("");
      await loadMembers(gid);
      await load();
      toast("Member added");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const removeMember = async (gid: string, uid: string) => {
    try {
      await api.del(`/api/groups/${gid}/members/${uid}`);
      await loadMembers(gid);
      await load();
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  const remove = async (g: OrgGroup) => {
    if (!confirm(`Delete group "${g.name}"? Its site and library grants are removed.`)) return;
    try {
      await api.del(`/api/groups/${g.id}`);
      await load();
      toast("Group deleted");
    } catch (e) { toast(e instanceof Error ? e.message : "Failed"); }
  };

  return (
    <Modal onClose={onClose} label="Groups">
      <h2>Groups</h2>
      <p className="d-sub">
        Groups are workspace-wide sets of people. Grant a group a site or library role once —
        membership changes flow everywhere it's used.
      </p>
      {isAdmin && (
        <div className="field" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input style={{ flex: 2, minWidth: 140 }} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Group name (e.g. Finance)" onKeyDown={(e) => e.key === "Enter" && void create()} />
          <input style={{ flex: 2, minWidth: 140 }} value={desc} onChange={(e) => setDesc(e.target.value)}
            placeholder="Purpose (optional)" />
          <button className="btn-primary btn-sm" disabled={busy || !name.trim()} onClick={() => void create()}>Create</button>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.id}>
          <div className="share-row">
            <div className="c-av">👥</div>
            <div style={{ flex: 1 }}>
              <b style={{ fontSize: 12.5 }}>{g.name}</b>
              <div style={{ fontSize: 11, color: "var(--muted)" }}>
                {g.memberCount ?? 0} member{(g.memberCount ?? 0) === 1 ? "" : "s"}
                {g.description ? ` · ${g.description}` : ""}
              </div>
            </div>
            <button className="btn-ghost btn-sm" onClick={() => {
              const next = openId === g.id ? null : g.id;
              setOpenId(next);
              if (next) void loadMembers(next);
            }}>{openId === g.id ? "Hide" : "Members"}</button>
            {isAdmin && <button className="x" title="Delete group" onClick={() => void remove(g)}>✕</button>}
          </div>
          {openId === g.id && (
            <div style={{ marginLeft: 24, marginBottom: 8 }}>
              {isAdmin && (
                <div className="field" style={{ display: "flex", gap: 8 }}>
                  <input style={{ flex: 1 }} value={memberEmail} onChange={(e) => setMemberEmail(e.target.value)}
                    placeholder="colleague@company.com" onKeyDown={(e) => e.key === "Enter" && void addMember(g.id)} />
                  <button className="btn-primary btn-sm" onClick={() => void addMember(g.id)}>Add</button>
                </div>
              )}
              {(members[g.id] ?? []).map((m) => (
                <div className="share-row" key={m.userId}>
                  <div className="c-av">{m.user.initials}</div>
                  <div style={{ flex: 1 }}>
                    <b style={{ fontSize: 12 }}>{m.user.displayName}</b>
                    <div style={{ fontSize: 11, color: "var(--muted)" }}>{m.user.email}</div>
                  </div>
                  {isAdmin && <button className="x" onClick={() => void removeMember(g.id, m.userId)}>✕</button>}
                </div>
              ))}
              {members[g.id] && !members[g.id].length && (
                <p className="d-sub" style={{ margin: "4px 0" }}>No members yet.</p>
              )}
            </div>
          )}
        </div>
      ))}
      {!groups.length && <p className="empty" style={{ margin: "8px 0" }}>No groups yet{isAdmin ? " — create one above" : ""}.</p>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn-ghost btn-sm" onClick={onClose}>Done</button>
      </div>
    </Modal>
  );
}
