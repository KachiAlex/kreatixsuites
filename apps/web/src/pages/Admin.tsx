// Admin policy center — org members, DLP/retention policies, audit log,
// workspace billing; plus the platform superadmin surface when user.isSuper.
// Server enforces owner/admin role; this UI is gated the same way.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { PUBLIC_ORIGIN } from "../lib/platform";
import { timeAgo } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/hooks";
import { SuperPortal } from "./SuperPortal";
interface Member {
  id: string; email: string; displayName: string; initials: string;
  role: string; disabled: boolean; createdAt: string;
}
interface Invite {
  id: string; token: string; max_uses: number; uses: number;
  expires_at: string | null; created_at: string; created_by_name: string;
}
interface PlanPub {
  slug: string; name: string; priceNgn: number; memberPriceNgn: number; amountNgn: number;
  features: Record<string, boolean>; limits: Record<string, number>;
}
interface BillingSub {
  state: string; status: string; until: string | null; daysLeft: number | null;
  seats: number; amountNgn: number; plan: string; planName: string; currency: string;
  features: Record<string, boolean>; limits: Record<string, number>; plans: PlanPub[];
  trialEndsAt: string | null; periodEnd: string | null;
  config: { trialMonths: number };
  paystackEnabled: boolean;
}
interface Payment {
  id: string; amount_ngn: number; seats: number; months: number;
  method: string; reference: string | null; status: string; plan?: string;
  period_start: string | null; period_end: string | null; created_at: string;
}
interface AiUsage {
  month: string; requests: number; tokens: number; costUsd: number;
  quota: { plan: string; tier?: string; orgTokensUsed: number; orgTokensLimit: number; userTodayUsed: number; userTodayLimit: number; trialRequestsUsed?: number; trialRequestsLimit?: number; resetsAt: string };
  byUser: { userId: string; name: string; requests: number; tokens: number }[];
  byDay: { day: string; requests: number; tokens: number }[];
  byMode: { mode: string; requests: number; tokens: number }[];
}
interface Policies {
  aiDisabled: boolean;
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
interface Metrics {
  uptimeSec: number;
  requests: { total: number; errors5xx: number; byStatus: Record<string, number> };
  collab: { rooms: number; peers: number };
  data: Record<string, number>;
  security: { encryptionAtRest: boolean; sso: boolean; saml?: boolean };
  memory: number;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner", admin: "Admin", member: "Member", guest: "Guest",
};

const fmtNgn = (n: number, cur = "₦") =>
  `${cur}${n.toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;

export function Admin() {
  const { msg, toast } = useToast();
  const { user } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteEmail, setInviteEmail] = useState("");
  const [billing, setBilling] = useState<{ subscription: BillingSub; payments: Payment[] } | null>(null);
  const [aiUsage, setAiUsage] = useState<AiUsage | null>(null);
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [encryption, setEncryption] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [filter, setFilter] = useState("");
  const [scimTokens, setScimTokens] = useState<{ id: string; label: string | null; created_at: string }[]>([]);
  const [newScimToken, setNewScimToken] = useState("");

  const isSuper = !!user?.isSuper;
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  const load = useCallback(async () => {
    // superadmin sessions are confined to the platform portal — the
    // workspace-admin endpoints 403 for them, so don't even ask.
    if (!isSuper) {
      const reqs: Promise<unknown>[] = [
        api.get<{ members: Member[] }>("/api/admin/members"),
        api.get<{ policies: Policies; encryptionAtRest: boolean }>("/api/admin/policies"),
        api.get<{ entries: AuditEntry[] }>("/api/admin/audit?limit=200"),
        api.get<Metrics>("/api/admin/metrics"),
        api.get<{ invites: Invite[] }>("/api/admin/invites"),
        api.get<{ subscription: BillingSub; payments: Payment[] }>("/api/billing"),
        api.get<{ tokens: { id: string; label: string | null; created_at: string }[] }>("/api/admin/scim/tokens"),
        api.get<AiUsage>("/api/billing/ai-usage"),
      ];
      const [m, p, a, mx, inv, bill, scim, ai] = await Promise.all(reqs) as [
        { members: Member[] },
        { policies: Policies; encryptionAtRest: boolean },
        { entries: AuditEntry[] },
        Metrics,
        { invites: Invite[] },
        { subscription: BillingSub; payments: Payment[] },
        { tokens: { id: string; label: string | null; created_at: string }[] },
        AiUsage,
      ];
      setMembers(m.members);
      setPolicies(p.policies);
      setEncryption(p.encryptionAtRest);
      setAudit(a.entries);
      setMetrics(mx);
      setInvites(inv.invites);
      setBilling(bill);
      setScimTokens(scim.tokens);
      setAiUsage(ai);
    }
  }, [isSuper]);

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

  const setDisabled = async (m: Member, disabled: boolean) => {
    try {
      await api.post(`/api/admin/members/${m.id}/disabled`, { disabled });
      setMembers((ms) => ms.map((x) => (x.id === m.id ? { ...x, disabled } : x)));
      toast(disabled ? `${m.displayName} removed from workspace` : `${m.displayName} re-enabled`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
    }
  };

  const createInvite = async (email?: string) => {
    try {
      const r = await api.post<{ id: string; token: string; emailed?: boolean }>(
        "/api/admin/invites", email ? { email } : {});
      if (r.emailed) {
        toast(`Invite emailed to ${email}`);
      } else {
        const url = `${PUBLIC_ORIGIN}/register?invite=${r.token}`;
        try { await navigator.clipboard.writeText(url); } catch { /* clipboard blocked */ }
        toast("Invite link created — copied to clipboard");
      }
      setInviteEmail("");
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Invite failed");
    }
  };

  const revokeInvite = async (id: string) => {
    await api.del(`/api/admin/invites/${id}`).catch(() => {});
    setInvites((xs) => xs.filter((i) => i.id !== id));
  };

  const createScimToken = async () => {
    const r = await api.post<{ id: string; token: string }>("/api/admin/scim/tokens", {})
      .catch((e: Error) => { toast(e.message || "Failed to create token"); return null; });
    if (!r) return;
    setScimTokens((xs) => [...xs, { id: r.id, label: null, created_at: new Date().toISOString() }]);
    setNewScimToken(r.token);
    try { await navigator.clipboard.writeText(r.token); } catch { /* clipboard denied */ }
  };

  const revokeScimToken = async (id: string) => {
    await api.del(`/api/admin/scim/tokens/${id}`).catch(() => {});
    setScimTokens((xs) => xs.filter((t) => t.id !== id));
  };

  const checkout = async (plan: string) => {
    try {
      const r = await api.post<{ mode: string; authorizationUrl?: string; message?: string; amountNgn?: number }>(
        "/api/billing/checkout", { months: 1, plan });
      if (r.mode === "paystack" && r.authorizationUrl) {
        location.href = r.authorizationUrl; // Paystack hosted checkout
      } else {
        toast(r.message ?? "Payment recorded — pending confirmation");
        void load();
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Checkout failed");
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
      {!isSuper && (
      <>
      <h1>Administration</h1>

      <section className="admin-card">
        <h2>Security posture</h2>
        <div className="admin-flags">
          <div className={`flag ${encryption ? "on" : "off"}`}>
            <b>Encryption at rest</b>
            <span>{encryption ? "Enabled (AES-256-GCM blobs + DB fields)" : "Not configured — set KREATIX_DATA_KEY"}</span>
          </div>
          <div className={`flag ${metrics?.security.sso ? "on" : "off"}`}>
            <b>Single sign-on</b>
            <span>{metrics?.security.sso ? "OIDC provider configured" : "Not configured — set KREATIX_OIDC_*"}</span>
          </div>
          <div className={`flag ${metrics?.security.saml ? "on" : "off"}`}>
            <b>SAML 2.0</b>
            <span>{metrics?.security.saml ? "IdP configured — metadata at /api/auth/saml/metadata" : "Not configured — set KREATIX_SAML_*"}</span>
          </div>
        </div>
      </section>

      {metrics && (
        <section className="admin-card">
          <h2>Health &amp; metrics</h2>
          <div className="admin-flags">
            <div className="flag on"><b>Uptime</b><span>{Math.floor(metrics.uptimeSec / 3600)}h {Math.floor((metrics.uptimeSec % 3600) / 60)}m</span></div>
            <div className={`flag ${metrics.requests.errors5xx ? "off" : "on"}`}>
              <b>Requests</b>
              <span>{metrics.requests.total} total · {metrics.requests.errors5xx} 5xx · {Object.entries(metrics.requests.byStatus).map(([k, v]) => `${k}:${v}`).join(" ")}</span>
            </div>
            <div className="flag on"><b>Live collab</b><span>{metrics.collab.rooms} rooms · {metrics.collab.peers} peers</span></div>
            <div className="flag on"><b>Data</b><span>{metrics.data.items} items · {metrics.data.versions} versions · {metrics.data.indexRows} indexed · {metrics.data.users} users</span></div>
            <div className="flag on"><b>Memory</b><span>{Math.round(metrics.memory / 1048576)} MB heap</span></div>
          </div>
        </section>
      )}

      <section className="admin-card">
        <h2>Data policies</h2>
        {policies && (
          <div className="admin-policies">
            <label className="pol-row">
              <input
                type="checkbox"
                checked={policies.aiDisabled}
                onChange={(e) => patchPolicy({ aiDisabled: e.target.checked })}
              />
              <span>
                <b>Disable Kreatix AI for this workspace</b>
                <em>All AI requests (chat, workspace ask, completions) are refused immediately — nothing leaves for the provider.</em>
              </span>
            </label>
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

      {billing && (
        <section className="admin-card" id="billing">
          <h2>Subscription &amp; billing</h2>
          {(() => {
            const s = billing.subscription;
            const stateLabel: Record<string, string> = {
              free: "Free plan — upgrade for more",
              trialing: `Free trial — ${s.daysLeft ?? 0} days left`,
              active: `Active — renews ${s.periodEnd ? new Date(s.periodEnd).toLocaleDateString() : "—"}`,
              grace: `Payment overdue — ${s.daysLeft ?? 0} days of grace left`,
              locked: "Suspended — workspace is read-only",
              granted: `Complimentary access until ${s.until ? new Date(s.until).toLocaleDateString() : "—"}`,
            };
            const paidPlans = s.plans.filter((p) => p.priceNgn > 0 || p.memberPriceNgn > 0);
            return (
              <>
                <div className="admin-flags">
                  <div className={`flag ${s.state === "locked" ? "off" : "on"}`}>
                    <b>Status</b><span>{stateLabel[s.state] ?? s.state}</span>
                  </div>
                  <div className="flag on"><b>Plan</b>
                    <span><span className="role-badge owner" style={{ marginRight: 6 }}>{s.planName}</span>
                      {s.amountNgn > 0
                        ? `${fmtNgn(s.amountNgn, "₦")}/mo`
                        : "₦0 — basic editing always free"}</span>
                  </div>
                  <div className="flag on"><b>Seats</b><span>{s.seats} active member{s.seats === 1 ? "" : "s"}</span></div>
                </div>
                {isOwnerOrAdmin && s.state !== "granted" && paidPlans.length > 0 && (
                  <div style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {paidPlans.map((p) => (
                      <button key={p.slug}
                        className={p.slug === s.plan ? "btn-primary" : "btn-secondary"}
                        onClick={() => void checkout(p.slug)}>
                        {p.slug === s.plan && s.state === "active" ? `Renew ${p.name}` :
                          `${s.state === "free" ? "Upgrade to " : p.slug === s.plan ? "Pay " : ""}${p.name}`} — {fmtNgn(p.amountNgn, "₦")}/mo
                        {p.memberPriceNgn > 0 && s.seats > 1 ? ` (${fmtNgn(p.priceNgn, "₦")} + ${s.seats - 1}×${fmtNgn(p.memberPriceNgn, "₦")})` : ""}
                      </button>
                    ))}
                    <div style={{ marginTop: 8, color: "var(--sub)", fontSize: 13, flexBasis: "100%" }}>
                      {s.paystackEnabled ? "Card / bank via Paystack" : "Bank transfer — confirmed by admin within 24h"}
                    </div>
                  </div>
                )}
                {billing.payments.length > 0 && (
                  <div className="tbl-scroll"><table className="admin-table" style={{ marginTop: 14 }}>
                    <thead><tr><th>When</th><th>Amount</th><th>Seats</th><th>Method</th><th>Status</th></tr></thead>
                    <tbody>
                      {billing.payments.map((p) => (
                        <tr key={p.id}>
                          <td>{timeAgo(p.created_at)}</td>
                          <td>{fmtNgn(p.amount_ngn, "₦")}</td>
                          <td>{p.seats}</td>
                          <td>{p.method}{p.plan === "business" ? " · Business" : ""}</td>
                          <td><span className={`role-badge ${p.status === "confirmed" ? "owner" : ""}`}>{p.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table></div>
                )}
              </>
            );
          })()}
        </section>
      )}

      {aiUsage && (
        <section className="admin-card" id="ai-usage">
          <h2>Kreatix AI usage</h2>
          <div className="admin-flags">
            <div className="flag on">
              <b>{aiUsage.quota.plan === "trial" ? "Trial AI" : aiUsage.quota.plan === "free" ? "Free tier AI" : "This month"}</b>
              <span>
                {aiUsage.quota.plan === "trial"
                  ? `${aiUsage.quota.trialRequestsUsed ?? 0} / ${aiUsage.quota.trialRequestsLimit ?? 0} requests used`
                  : `${aiUsage.tokens.toLocaleString()} tokens · ~$${aiUsage.costUsd.toFixed(2)} est. cost`}
              </span>
            </div>
            <div className={`flag ${aiUsage.tokens >= aiUsage.quota.orgTokensLimit * 0.8 ? "off" : "on"}`}>
              <b>Budget</b>
              <span>
                {aiUsage.quota.plan === "trial"
                  ? "Subscribe for a monthly AI budget"
                  : `${Math.round((aiUsage.tokens / Math.max(1, aiUsage.quota.orgTokensLimit)) * 100)}% of ${aiUsage.quota.orgTokensLimit.toLocaleString()} credits`}
              </span>
            </div>
            <div className="flag on"><b>Requests</b><span>{aiUsage.requests.toLocaleString()} this month</span></div>
            <div className="flag on"><b>Plan tier</b>
              <span>
                {aiUsage.quota.plan === "trial"
                  ? "Trial — subscribe for a monthly AI allowance"
                  : aiUsage.quota.plan === "free"
                    ? `Free — ${aiUsage.quota.userTodayLimit ?? 0} requests/day/user · upgrade for more`
                    : `${billing?.subscription.planName ?? aiUsage.quota.tier} — ${aiUsage.quota.orgTokensLimit.toLocaleString()} credits/mo`}
              </span>
            </div>
          </div>
          {(aiUsage.byDay?.length ?? 0) > 0 && (() => {
            const days = aiUsage.byDay;
            const peak = Math.max(1, ...days.map((d) => d.tokens));
            return (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 48 }} role="img"
                  aria-label={`AI tokens per day, peak ${peak.toLocaleString()}`}>
                  {days.map((d) => (
                    <div key={d.day} title={`${d.day.slice(5)}: ${d.requests} req · ${d.tokens.toLocaleString()} tok`}
                      style={{ flex: 1, minWidth: 2, height: `${Math.max(4, (d.tokens / peak) * 100)}%`,
                        background: "var(--k-orange)", borderRadius: "2px 2px 0 0", opacity: 0.85 }} />
                  ))}
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)", marginTop: 3 }}>
                  <span>{days[0].day.slice(5)}</span><span>tokens/day (30d)</span><span>{days[days.length - 1].day.slice(5)}</span>
                </div>
              </div>
            );
          })()}
          {(aiUsage.byMode?.length ?? 0) > 0 && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 12 }}>
              {aiUsage.byMode.map((m) => (
                <span key={m.mode} className="role-badge" title={`${m.requests} requests`}>
                  {m.mode} · {m.tokens.toLocaleString()} tok
                </span>
              ))}
            </div>
          )}
          {aiUsage.byUser.length > 0 && (
            <div className="tbl-scroll"><table className="admin-table" style={{ marginTop: 14 }}>
              <thead><tr><th>Member</th><th>Requests</th><th>Tokens</th></tr></thead>
              <tbody>
                {aiUsage.byUser.map((u) => (
                  <tr key={u.userId}>
                    <td>{u.name}</td>
                    <td>{u.requests}</td>
                    <td>{u.tokens.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </section>
      )}

      <section className="admin-card">
        <h2>Members</h2>
        <div className="audit-bar" style={{ marginBottom: 10 }}>
          <button className="btn-secondary" onClick={() => void createInvite()}>+ Invite link</button>
          <input style={{ width: 220 }} placeholder="invite by email…"
            value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && inviteEmail.trim()) void createInvite(inviteEmail.trim()); }} />
          <button className="btn-secondary" disabled={!inviteEmail.trim()}
            onClick={() => void createInvite(inviteEmail.trim())}>Email invite</button>
          {invites.map((i) => (
            <span key={i.id} className="role-badge" title={`${i.uses}/${i.max_uses} uses`}>
              {PUBLIC_ORIGIN}/register?invite={i.token.slice(0, 8)}…
              <button style={{ marginLeft: 6, border: 0, background: "none", cursor: "pointer" }}
                onClick={() => void revokeInvite(i.id)}>✕</button>
            </span>
          ))}
        </div>
        <div className="tbl-scroll"><table className="admin-table">
          <thead><tr><th></th><th>Name</th><th>Email</th><th>Role</th><th>Joined</th><th></th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} style={m.disabled ? { opacity: 0.5 } : undefined}>
                <td><span className="member-av">{m.initials}</span></td>
                <td>{m.displayName}{m.disabled && <span className="role-badge" style={{ marginLeft: 8 }}>disabled</span>}</td>
                <td>{m.email}</td>
                <td>
                  {m.role === "owner" ? (
                    <span className="role-badge owner">Owner</span>
                  ) : (
                    <select value={m.role} onChange={(e) => setRole(m, e.target.value)} disabled={m.disabled}>
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="guest">Guest</option>
                    </select>
                  )}
                </td>
                <td>{timeAgo(m.createdAt)}</td>
                <td>
                  {m.role !== "owner" && (
                    <button className="btn-secondary" style={{ padding: "2px 10px", fontSize: 12 }}
                      onClick={() => void setDisabled(m, !m.disabled)}>
                      {m.disabled ? "Re-enable" : "Remove"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </section>

      <section className="admin-card">
        <h2>SCIM provisioning</h2>
        <div className="pol-row" style={{ alignItems: "stretch", flexDirection: "column" }}>
          <span>
            <b>Endpoint</b> <code>{PUBLIC_ORIGIN}/scim/v2</code>
            <em style={{ display: "block" }}>Point your identity provider (Okta, Entra ID, OneLogin) at this URL with a bearer token below. Supports Users create/update/deactivate/delete.</em>
          </span>
        </div>
        <div className="audit-bar" style={{ marginTop: 8 }}>
          <button className="btn-secondary" onClick={() => void createScimToken()}>+ Provisioning token</button>
          {scimTokens.map((t) => (
            <span key={t.id} className="role-badge" title={new Date(t.created_at).toLocaleString()}>
              {t.label || `token …${t.id.slice(0, 6)}`}
              <button style={{ marginLeft: 6, border: 0, background: "none", cursor: "pointer" }}
                onClick={() => void revokeScimToken(t.id)}>✕</button>
            </span>
          ))}
        </div>
        {newScimToken && (
          <div className="pol-row" style={{ marginTop: 8 }}>
            <span>
              <b>Copy this token now — it is shown once:</b>
              <code style={{ display: "block", wordBreak: "break-all", marginTop: 4 }}>{newScimToken}</code>
              <button className="btn-secondary" style={{ marginTop: 6 }}
                onClick={() => { void navigator.clipboard.writeText(newScimToken); toast("Copied"); }}>Copy</button>
              <button className="btn-ghost" style={{ marginTop: 6, marginLeft: 6 }} onClick={() => setNewScimToken("")}>Dismiss</button>
            </span>
          </div>
        )}
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
        <div className="tbl-scroll"><table className="admin-table">
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
        </table></div>
      </section>
      </>
      )}

      {isSuper && <SuperPortal />}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </div>
  );
}
