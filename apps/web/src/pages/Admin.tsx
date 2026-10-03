// Admin policy center — org members, DLP/retention policies, audit log,
// workspace billing; plus the platform superadmin surface when user.isSuper.
// Server enforces owner/admin role; this UI is gated the same way.
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/hooks";

// module-scope so Date.now() runs outside the component's render scope
async function grantDays(orgId: string, days: number) {
  const until = new Date(Date.now() + days * 86400000).toISOString();
  await api.patch(`/api/superadmin/orgs/${orgId}/subscription`, { overrideUntil: until });
}
interface Member {
  id: string; email: string; displayName: string; initials: string;
  role: string; disabled: boolean; createdAt: string;
}
interface Invite {
  id: string; token: string; max_uses: number; uses: number;
  expires_at: string | null; created_at: string; created_by_name: string;
}
interface BillingSub {
  state: string; status: string; until: string | null; daysLeft: number | null;
  seats: number; amountNgn: number; currency: string;
  trialEndsAt: string | null; periodEnd: string | null;
  config: { basePriceNgn: number; memberPriceNgn: number; trialMonths: number };
  paystackEnabled: boolean;
}
interface Payment {
  id: string; amount_ngn: number; seats: number; months: number;
  method: string; reference: string | null; status: string;
  period_start: string | null; period_end: string | null; created_at: string;
}
interface BillingCfg {
  base_price_ngn: number; member_price_ngn: number; trial_months: number; currency: string;
}
interface SaOrg {
  id: string; name: string; created_at: string; seats: number;
  state: string; monthlyAmountNgn: number; status: string | null;
  trial_ends_at: string | null; period_end: string | null; override_until: string | null;
}
interface SaOverview {
  orgs: number; users: number; activeSubs: number; trialing: number;
  locked: number; pendingPayments: number; mrrNgn: number;
}
interface SaPayment extends Payment { org_id: string; org_name: string }
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
  const [policies, setPolicies] = useState<Policies | null>(null);
  const [encryption, setEncryption] = useState(false);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [filter, setFilter] = useState("");
  const [scimTokens, setScimTokens] = useState<{ id: string; label: string | null; created_at: string }[]>([]);
  const [newScimToken, setNewScimToken] = useState("");
  // superadmin (platform) state
  const [saOverview, setSaOverview] = useState<SaOverview | null>(null);
  const [saOrgs, setSaOrgs] = useState<SaOrg[]>([]);
  const [saPayments, setSaPayments] = useState<SaPayment[]>([]);
  const [billingCfg, setBillingCfg] = useState<BillingCfg | null>(null);

  const isSuper = !!user?.isSuper;
  const isOwnerOrAdmin = user?.role === "owner" || user?.role === "admin";

  const load = useCallback(async () => {
    const reqs: Promise<unknown>[] = [
      api.get<{ members: Member[] }>("/api/admin/members"),
      api.get<{ policies: Policies; encryptionAtRest: boolean }>("/api/admin/policies"),
      api.get<{ entries: AuditEntry[] }>("/api/admin/audit?limit=200"),
      api.get<Metrics>("/api/admin/metrics"),
      api.get<{ invites: Invite[] }>("/api/admin/invites"),
      api.get<{ subscription: BillingSub; payments: Payment[] }>("/api/billing"),
      api.get<{ tokens: { id: string; label: string | null; created_at: string }[] }>("/api/admin/scim/tokens"),
    ];
    const [m, p, a, mx, inv, bill, scim] = await Promise.all(reqs) as [
      { members: Member[] },
      { policies: Policies; encryptionAtRest: boolean },
      { entries: AuditEntry[] },
      Metrics,
      { invites: Invite[] },
      { subscription: BillingSub; payments: Payment[] },
      { tokens: { id: string; label: string | null; created_at: string }[] },
    ];
    setMembers(m.members);
    setPolicies(p.policies);
    setEncryption(p.encryptionAtRest);
    setAudit(a.entries);
    setMetrics(mx);
    setInvites(inv.invites);
    setBilling(bill);
    setScimTokens(scim.tokens);
    if (isSuper) {
      const [ov, og, pay, cfg] = await Promise.all([
        api.get<SaOverview>("/api/superadmin/overview"),
        api.get<{ orgs: SaOrg[] }>("/api/superadmin/orgs"),
        api.get<{ payments: SaPayment[] }>("/api/superadmin/payments?status=pending"),
        api.get<{ config: BillingCfg }>("/api/superadmin/billing-config"),
      ]);
      setSaOverview(ov);
      setSaOrgs(og.orgs);
      setSaPayments(pay.payments);
      setBillingCfg(cfg.config);
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
        const url = `${location.origin}/register?invite=${r.token}`;
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

  const checkout = async () => {
    try {
      const r = await api.post<{ mode: string; authorizationUrl?: string; message?: string; amountNgn?: number }>(
        "/api/billing/checkout", { months: 1 });
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

  const saveBillingCfg = async (patch: Partial<BillingCfg>) => {
    try {
      const r = await api.put<{ config: BillingCfg }>("/api/superadmin/billing-config", patch);
      setBillingCfg(r.config);
      toast("Pricing updated");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Update failed");
    }
  };

  const saConfirm = async (id: string, confirm: boolean) => {
    try {
      await api.post(`/api/superadmin/payments/${id}/${confirm ? "confirm" : "reject"}`, {});
      toast(confirm ? "Payment confirmed — workspace activated" : "Payment rejected");
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
    }
  };

  const saComp = async (orgId: string, days: number) => {
    try {
      await grantDays(orgId, days);
      toast(`Granted ${days} days of access`);
      void load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
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
              trialing: `Free trial — ${s.daysLeft ?? 0} days left`,
              active: `Active — renews ${s.periodEnd ? new Date(s.periodEnd).toLocaleDateString() : "—"}`,
              grace: `Payment overdue — ${s.daysLeft ?? 0} days of grace left`,
              locked: "Locked — workspace is read-only",
              granted: `Complimentary access until ${s.until ? new Date(s.until).toLocaleDateString() : "—"}`,
            };
            return (
              <>
                <div className="admin-flags">
                  <div className={`flag ${s.state === "locked" ? "off" : "on"}`}>
                    <b>Status</b><span>{stateLabel[s.state] ?? s.state}</span>
                  </div>
                  <div className="flag on"><b>Plan</b>
                    <span>{fmtNgn(s.config.basePriceNgn, "₦")} admin + {fmtNgn(s.config.memberPriceNgn, "₦")} × {Math.max(0, s.seats - 1)} member{s.seats - 1 === 1 ? "" : "s"} = <b>{fmtNgn(s.amountNgn, "₦")}/mo</b></span>
                  </div>
                  <div className="flag on"><b>Seats</b><span>{s.seats} active member{s.seats === 1 ? "" : "s"}</span></div>
                </div>
                {isOwnerOrAdmin && s.state !== "granted" && (
                  <div style={{ marginTop: 12 }}>
                    <button className="btn-primary" onClick={() => void checkout()}>
                      {s.state === "trialing" ? `Pay now (${fmtNgn(s.amountNgn, "₦")}/mo)` : `Renew — ${fmtNgn(s.amountNgn, "₦")}/mo`}
                    </button>
                    <span style={{ marginLeft: 10, color: "var(--sub)", fontSize: 13 }}>
                      {s.paystackEnabled ? "Card / bank via Paystack" : "Bank transfer — confirmed by admin within 24h"}
                    </span>
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
                          <td>{p.method}</td>
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
              {location.origin}/register?invite={i.token.slice(0, 8)}…
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
            <b>Endpoint</b> <code>{location.origin}/scim/v2</code>
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

      {isSuper && (
        <>
          <h1 style={{ marginTop: 32 }}>Platform (superadmin)</h1>

          {saOverview && (
            <section className="admin-card">
              <h2>Overview</h2>
              <div className="admin-flags">
                <div className="flag on"><b>Workspaces</b><span>{saOverview.orgs} total · {saOverview.users} users</span></div>
                <div className="flag on"><b>Subscriptions</b><span>{saOverview.trialing} trialing · {saOverview.activeSubs} active · {saOverview.locked} locked</span></div>
                <div className="flag on"><b>MRR</b><span>{fmtNgn(saOverview.mrrNgn, "₦")}/mo</span></div>
                <div className={`flag ${saOverview.pendingPayments ? "off" : "on"}`}>
                  <b>Pending payments</b><span>{saOverview.pendingPayments}</span>
                </div>
              </div>
            </section>
          )}

          {billingCfg && (
            <section className="admin-card">
              <h2>Plan &amp; pricing</h2>
              <div className="admin-policies">
                <label className="pol-row">
                  <input type="number" min={0} style={{ width: 100 }} defaultValue={billingCfg.base_price_ngn}
                    onBlur={(e) => { const v = Number(e.target.value); if (v !== billingCfg.base_price_ngn) void saveBillingCfg({ base_price_ngn: v }); }} />
                  <span><b>Admin seat (₦/mo)</b><em>The workspace owner's seat.</em></span>
                </label>
                <label className="pol-row">
                  <input type="number" min={0} style={{ width: 100 }} defaultValue={billingCfg.member_price_ngn}
                    onBlur={(e) => { const v = Number(e.target.value); if (v !== billingCfg.member_price_ngn) void saveBillingCfg({ member_price_ngn: v }); }} />
                  <span><b>Per member (₦/mo)</b><em>Each additional enabled member.</em></span>
                </label>
                <label className="pol-row">
                  <input type="number" min={0} max={24} style={{ width: 72 }} defaultValue={billingCfg.trial_months}
                    onBlur={(e) => { const v = Number(e.target.value); if (v !== billingCfg.trial_months) void saveBillingCfg({ trial_months: v }); }} />
                  <span><b>Free trial (months)</b><em>Applies to workspaces created after the change.</em></span>
                </label>
                <label className="pol-row">
                  <input style={{ width: 72 }} defaultValue={billingCfg.currency}
                    onBlur={(e) => { if (e.target.value !== billingCfg.currency) void saveBillingCfg({ currency: e.target.value }); }} />
                  <span><b>Currency</b><em>ISO code shown on invoices.</em></span>
                </label>
              </div>
            </section>
          )}

          {saPayments.length > 0 && (
            <section className="admin-card">
              <h2>Pending payments</h2>
              <div className="tbl-scroll"><table className="admin-table">
                <thead><tr><th>When</th><th>Workspace</th><th>Amount</th><th>Method</th><th></th></tr></thead>
                <tbody>
                  {saPayments.map((p) => (
                    <tr key={p.id}>
                      <td>{timeAgo(p.created_at)}</td>
                      <td>{p.org_name}</td>
                      <td>{fmtNgn(p.amount_ngn, "₦")}</td>
                      <td>{p.method}{p.reference ? ` · ${p.reference.slice(0, 18)}` : ""}</td>
                      <td>
                        <button className="btn-primary" style={{ padding: "2px 10px", fontSize: 12, marginRight: 6 }}
                          onClick={() => void saConfirm(p.id, true)}>Confirm</button>
                        <button className="btn-secondary" style={{ padding: "2px 10px", fontSize: 12 }}
                          onClick={() => void saConfirm(p.id, false)}>Reject</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table></div>
            </section>
          )}

          <section className="admin-card">
            <h2>Workspaces</h2>
            <div className="tbl-scroll"><table className="admin-table">
              <thead><tr><th>Workspace</th><th>Seats</th><th>State</th><th>Monthly</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {saOrgs.map((o) => (
                  <tr key={o.id}>
                    <td>{o.name}</td>
                    <td>{o.seats}</td>
                    <td><span className={`role-badge ${o.state === "active" || o.state === "granted" ? "owner" : ""}`}>{o.state}</span></td>
                    <td>{fmtNgn(o.monthlyAmountNgn, "₦")}</td>
                    <td>{timeAgo(o.created_at)}</td>
                    <td>
                      <button className="btn-secondary" style={{ padding: "2px 10px", fontSize: 12 }}
                        onClick={() => void saComp(o.id, 30)}>+30d comp</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </section>
        </>
      )}
      {msg && <div className="toast" role="status" aria-live="polite">{msg}</div>}
    </div>
  );
}
