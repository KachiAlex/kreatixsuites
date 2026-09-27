// Admin policy center — org members, DLP/retention policies, audit log.
// Server enforces owner/admin role; this UI is gated the same way.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useToast } from "./Home";

interface Member {
  id: string; email: string; displayName: string; initials: string;
  role: string; createdAt: string;
}
interface Policies {
  blockPublicLinksForConfidential: boolean;
  blockRestrictedShareLinks: boolean;
  trashRetentionDays: number;
  dlpPatterns: string[];
}
interface AuditEntry {
  id: string; action: string; detail: string | null; created_at: string;
  actor_name: string | null; actor_email: string | null;
  file_name: string | null; file_id: string | null;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner", admin: "Admin", member: "Member", guest: "Guest",
};

export function Admin() {
  const { msg, toast } = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [encryption, setEncryption] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    const [m, p, a] = await Promise.all([
      api.get<{ members: Member[] }>("/api/admin/members"),
      api.get<{ policies: Policies; encryptionAtRest: boolean }>("/api/admin/policies"),
      api.get<{ entries: AuditEntry[] }>("/api/admin/audit?limit=200"),
    ]);
    setMembers(m.members);
    setPolicies(p.policies);
    setEncryption(p.encryptionAtRest);
    setAudit(a.entries);
  }, []);

  useEffect(() => { load().catch((e) => toast(e instanceof Error ? e.message : "Load failed")); }, [load, toast]);

  const setRole = async (m: Member, role: string) => {
    try {
      await api.patch(`/api/admin/members/${m.id}`, { role });
      setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, role } : x)));
      toast(`${m.displayName} is now ${ROLE_LABELS[role] ?? role}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Role change failed");
    }
  };

  const patchPolicy = async (patch: Partial<Policies>) => {
    try {
      const r = await api.put<{ policies: Policies }>("/api/admin/policies", patch);
      setPolicies(r.policies);
      toast("Policy updated");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Policy update failed");
    }
  };

  const filtered = filter
    ? audit.filter((e) =>
        `${e.action} ${e.actor_name ?? ""} ${e.file_name ?? ""} ${e.detail ?? ""}`
          .toLowerCase().includes(filter.toLowerCase()))
    : audit;

  return (
    <div className="admin-page">
      <h1>Administration</h1>

      <section className="admin-card">
        <h2>Security posture</h2>
        <div className="admin-flags">
          <div className={`flag ${encryption ? "on" : "off"}`}>
            <b>Encryption at rest</b>
            <span>{encryption ? "Enabled (AES-256-GCM blob store)" : "Not configured — set KREATIX_DATA_KEY"}</span>
          </div>
        </div>
      </section>

      <section className="admin-card">
        <h2>Data policies</h2>
        {policies && (
          <div className="admin-policies">
            <label className="pol-row">
              <input
                type="checkbox"
                checked={policies.blockPublicLinksForConfidential}
                onChange={(e) => patchPolicy({ blockPublicLinksForConfidential: e.target.checked })}
              />
              <span>
                <b>Block public share links for Confidential + Restricted files</b>
                <em>Editors get a policy error when creating link shares on labeled files.</em>
              </span>
            </label>
            <label className="pol-row">
              <input
                type="checkbox"
                checked={policies.blockRestrictedShareLinks}
                onChange={(e) => patchPolicy({ blockRestrictedShareLinks: e.target.checked })}
              />
              <span>
                <b>Block all share links for Restricted files</b>
                <em>Restricted files can only be shared person-to-person, never via links.</em>
              </span>
            </label>
            <label className="pol-row">
              <input
                type="number" min={0} max={3650} style={{ width: 72 }}
                value={policies.trashRetentionDays}
                onChange={(e) => patchPolicy({ trashRetentionDays: Math.max(0, Number(e.target.value) || 0) })}
              />
              <span>
                <b>Recycle-bin retention (days)</b>
                <em>Trashed items older than this are permanently purged daily. 0 = keep forever.</em>
              </span>
            </label>
            <label className="pol-row" style={{ alignItems: "stretch", flexDirection: "column" }}>
              <span>
                <b>DLP content patterns</b>
                <em>One regex per line — share links are blocked on files whose name or indexed text matches.
                  e.g. <code>\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}\b</code> for card numbers. Max 10.</em>
              </span>
              <textarea
                rows={3}
                defaultValue={policies.dlpPatterns.join("\n")}
                placeholder={"\\b\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}\\b\nCONFIDENTIAL-\\d+"}
                onBlur={(e) => {
                  const patterns = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 10);
                  if (patterns.join("\n") !== policies.dlpPatterns.join("\n")) {
                    void patchPolicy({ dlpPatterns: patterns });
                  }
                }}
                style={{ fontFamily: "monospace", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}
              />
            </label>
          </div>
        )}
      </section>

      <section className="admin-card">
        <h2>Members</h2>
        <table className="admin-table">
          <thead><tr><th></th><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td><span className="member-av">{m.initials}</span></td>
                <td>{m.displayName}</td>
                <td>{m.email}</td>
                <td>
                  {m.role === "owner" ? (
                    <span className="role-badge owner">Owner</span>
                  ) : (
                    <select value={m.role} onChange={(e) => setRole(m, e.target.value)}>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="guest">Guest</option>
                    </select>
                  )}
                </td>
                <td>{timeAgo(m.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="admin-card">
        <h2>Audit log</h2>
        <div className="audit-bar">
          <input
            placeholder="Filter by action, actor, or file…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button className="btn-secondary" onClick={() => void load()}>Refresh</button>
        </div>
        <table className="admin-table">
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>File</th><th>Detail</th></tr></thead>
          <tbody>
            {filtered.map((e) => (
              <tr key={e.id}>
                <td title={e.created_at}>{timeAgo(e.created_at)}</td>
                <td>{e.actor_name ?? "—"}</td>
                <td><code>{e.action}</code></td>
                <td>{e.file_name ?? "—"}</td>
                <td>{e.detail ?? ""}</td>
              </tr>
            ))}
            {!filtered.length && (
              <tr><td colSpan={5} style={{ color: "var(--sub)", textAlign: "center" }}>No activity recorded</td></tr>
            )}
          </tbody>
        </table>
      </section>
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}
