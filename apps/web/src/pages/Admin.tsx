// Admin policy center — org members, DLP/retention policies, audit log,
// workspace billing; plus the platform superadmin surface when user.isSuper.
// Server enforces owner/admin role; this UI is gated the same way.
import { Fragment, useCallback, useEffect, useState } from "react";
import { api, getToken } from "../lib/api";
import { PUBLIC_ORIGIN, API_BASE } from "../lib/platform";
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
  dlpOnSave: "off" | "flag" | "block";
  watermarkConfidentialExports: boolean;
  allowedIpRanges: string[];
  requireDesktopClient: boolean;
}
interface Hold {
  id: string; name: string; description: string | null; active: boolean;
  createdBy: string; createdAt: string; itemCount: number;
}
interface AuditEntry {
  id: string; action: string; detail: string | null; created_at: string;
  actor_name: string | null; actor_email: string | null;
  file_name: string | null; file_id: string | null;
}
interface DnsRecord { type: string; host: string; value: string; purpose: string; required: boolean; ok: boolean | null }
interface OrgDomain {
  id: string; domain: string; status: string; isPrimary: boolean; mxOk: boolean; brevoOk: boolean;
  verifyToken: string | null; verifiedAt: string | null; createdAt: string; dns: DnsRecord[];
}
interface Rule {
  id: string; name: string; enabled: boolean; trigger: string;
  match: Record<string, string> | null; action: string;
  config: Record<string, string | null>; createdBy: string; createdAt: string;
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
  const [auditActions, setAuditActions] = useState<string[]>([]);
  const [auditAction, setAuditAction] = useState("");
  const [auditUser, setAuditUser] = useState("");
  const [auditFrom, setAuditFrom] = useState("");
  const [auditTo, setAuditTo] = useState("");
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [filter, setFilter] = useState("");
  const [scimTokens, setScimTokens] = useState<{ id: string; label: string | null; created_at: string }[]>([]);
  const [newScimToken, setNewScimToken] = useState("");
  const [domains, setDomains] = useState<OrgDomain[]>([]);
  const [newDomain, setNewDomain] = useState("");
  const [domainBusy, setDomainBusy] = useState<string | null>(null);
  const [openDomain, setOpenDomain] = useState<string | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [ruleMeta, setRuleMeta] = useState<{
    triggers: { id: string; label: string; matchKeys?: { key: string; label: string; kind: "select" | "number" }[] }[];
    actions: { id: string; label: string; needs?: string; fields?: { key: string; label: string; kind: string }[] }[];
  }>({ triggers: [], actions: [] });
  const [forms, setForms] = useState<{ id: string; title: string }[]>([]);
  const [libs, setLibs] = useState<{ id: string; name: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string; legalHold?: boolean }[]>([]);
  const [ruleForm, setRuleForm] = useState<{ name: string; trigger: string; action: string; match: Record<string, string>; cfg: Record<string, string> }>({
    name: "", trigger: "form.submitted", action: "task.create", match: {}, cfg: {},
  });
  const [runsFor, setRunsFor] = useState<string | null>(null);
  const [runs, setRuns] = useState<{ dedupe_key: string; fired_at: string; ok: boolean | null; detail: Record<string, string> | null }[]>([]);
  const [holds, setHolds] = useState<Hold[]>([]);
  const [holdName, setHoldName] = useState("");
  const [holdItems, setHoldItems] = useState<{ id: string; name: string; kind: string; owner: string }[]>([]);
  const [holdCusts, setHoldCusts] = useState<{ id: string; name: string; email: string; itemCount: number }[]>([]);
  const [holdOpen, setHoldOpen] = useState<string | null>(null);
  const [custPick, setCustPick] = useState("");
  const [ediscUser, setEdiscUser] = useState("");
  const [dlpRules, setDlpRules] = useState<{ id: string; name: string; pattern: string; severity: string; action: string; applies_to: string; enabled: boolean }[]>([]);
  const [dlpEvents, setDlpEvents] = useState<{ id: string; rule: string; refType: string; refId: string; excerpt: string | null; action: string; actor: string | null; itemName: string | null; createdAt: string }[]>([]);
  const [dlpTab, setDlpTab] = useState<"open" | "confirmed" | "dismissed">("open");
  const [dlpForm, setDlpForm] = useState({ name: "", pattern: "", severity: "medium", action: "flag", appliesTo: "files" });
  const [apiKeys, setApiKeys] = useState<{ id: string; name: string; prefix: string; scopes: string[]; last_used_at: string | null; creator: string | null }[]>([]);
  const [newKey, setNewKey] = useState<{ name: string; scopes: string[] }>({ name: "", scopes: ["read"] });
  const [freshKey, setFreshKey] = useState("");
  const [webhooks, setWebhooks] = useState<{ id: string; url: string; events: string[]; active: boolean; failures: number; last_delivered: string | null }[]>([]);
  const [hookForm, setHookForm] = useState({ url: "", events: "" });
  const [hookDeliveries, setHookDeliveries] = useState<{ id: string; event: string; status: string; attempts: number; response_code: number | null; created_at: string }[]>([]);
  const [hookOpen, setHookOpen] = useState<string | null>(null);

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
        api.get<{ actions: string[] }>("/api/admin/audit/actions"),
        api.get<Metrics>("/api/admin/metrics"),
        api.get<{ invites: Invite[] }>("/api/admin/invites"),
        api.get<{ subscription: BillingSub; payments: Payment[] }>("/api/billing"),
        api.get<{ tokens: { id: string; label: string | null; created_at: string }[] }>("/api/admin/scim/tokens"),
        api.get<AiUsage>("/api/billing/ai-usage"),
        api.get<{ domains: OrgDomain[] }>("/api/admin/domains"),
        api.get<{ rules: Rule[]; triggers: { id: string; label: string }[]; actions: { id: string; label: string }[] }>("/api/rules"),
        api.get<{ forms: { id: string; title: string }[] }>("/api/forms"),
        api.get<{ sites: { id: string; name: string; legalHold?: boolean; libraries?: { id: string; name: string }[] }[] }>("/api/sites"),
        api.get<{ holds: Hold[] }>("/api/admin/holds"),
        api.get<{ rules: typeof dlpRules }>("/api/admin/dlp/rules"),
        api.get<{ events: typeof dlpEvents }>("/api/admin/dlp/events?status=open"),
        api.get<{ keys: typeof apiKeys }>("/api/admin/api-keys"),
        api.get<{ hooks: typeof webhooks }>("/api/admin/webhooks"),
      ];
      const [m, p, a, acts, mx, inv, bill, scim, ai, dom, rl, fm, st, hl, dr, de, ak, wh] = await Promise.all(reqs) as [
        { members: Member[] },
        { policies: Policies; encryptionAtRest: boolean },
        { entries: AuditEntry[] },
        { actions: string[] },
        Metrics,
        { invites: Invite[] },
        { subscription: BillingSub; payments: Payment[] },
        { tokens: { id: string; label: string | null; created_at: string }[] },
        AiUsage,
        { domains: OrgDomain[] },
        { rules: Rule[]; triggers: { id: string; label: string }[]; actions: { id: string; label: string }[] },
        { forms: { id: string; title: string }[] },
        { sites: { id: string; name: string; legalHold?: boolean; libraries?: { id: string; name: string }[] }[] },
        { holds: Hold[] },
        { rules: typeof dlpRules },
        { events: typeof dlpEvents },
        { keys: typeof apiKeys },
        { hooks: typeof webhooks },
      ];
      setMembers(m.members);
      setPolicies(p.policies);
      setEncryption(p.encryptionAtRest);
      setAudit(a.entries);
      setAuditActions(acts.actions);
      setMetrics(mx);
      setInvites(inv.invites);
      setBilling(bill);
      setScimTokens(scim.tokens);
      setAiUsage(ai);
      setDomains(dom.domains);
      setRules(rl.rules);
      setRuleMeta({ triggers: rl.triggers, actions: rl.actions });
      setForms(fm.forms);
      setLibs((st.sites ?? []).flatMap((s) => s.libraries ?? []));
      setSites((st.sites ?? []).map((s) => ({ id: s.id, name: s.name, legalHold: s.legalHold })));
      setHolds(hl.holds);
      setDlpRules(dr.rules);
      setDlpEvents(de.events);
      setApiKeys(ak.keys);
      setWebhooks(wh.hooks);
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

  const addDomain = async () => {
    const domain = newDomain.trim().toLowerCase();
    if (!domain) return;
    setDomainBusy("add");
    try {
      const r = await api.post<{ domain: OrgDomain }>("/api/admin/domains", { domain });
      setDomains((xs) => [...xs, r.domain]);
      setNewDomain("");
      setOpenDomain(r.domain.id);
      toast(`Added ${r.domain.domain} — publish the TXT record, then verify`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add domain");
    }
    setDomainBusy(null);
  };

  const verifyDomain = async (d: OrgDomain) => {
    setDomainBusy(d.id);
    try {
      const r = await api.post<{ domain: OrgDomain }>(`/api/admin/domains/${d.id}/verify`, {});
      setDomains((xs) => xs.map((x) => (x.id === d.id ? r.domain : x)));
      toast(`${d.domain} verified — set it primary to use it for mailboxes`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Verification failed");
      void load();
    }
    setDomainBusy(null);
  };

  const setPrimaryDomain = async (d: OrgDomain) => {
    setDomainBusy(d.id);
    try {
      await api.post(`/api/admin/domains/${d.id}/primary`, {});
      setDomains((xs) => xs.map((x) => ({ ...x, isPrimary: x.id === d.id })));
      toast(`New mailboxes will use @${d.domain}`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed");
    }
    setDomainBusy(null);
  };

  const removeDomain = async (d: OrgDomain) => {
    if (!confirm(`Remove ${d.domain}? Mailboxes already created keep their address.`)) return;
    await api.del(`/api/admin/domains/${d.id}`).catch((e) => toast((e as Error).message));
    setDomains((xs) => xs.filter((x) => x.id !== d.id));
  };

  const copyRec = async (v: string) => {
    try { await navigator.clipboard.writeText(v); toast("Copied"); } catch { /* denied */ }
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

  const auditQuery = () => {
    const p = new URLSearchParams({ limit: "500" });
    if (auditAction) p.set("action", auditAction);
    if (auditUser) p.set("user", auditUser);
    if (auditFrom) p.set("from", new Date(auditFrom).toISOString());
    if (auditTo) p.set("to", new Date(new Date(auditTo).getTime() + 86400000 - 1).toISOString());
    return p.toString();
  };
  const reloadAudit = async () => {
    try {
      const r = await api.get<{ entries: AuditEntry[] }>(`/api/admin/audit?${auditQuery()}`);
      setAudit(r.entries);
    } catch (e) { toast((e as Error).message); }
  };
  const exportAudit = async () => {
    try {
      const blob = await api.get<Blob>(`/api/admin/audit.csv?${auditQuery()}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `kreatix-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click(); URL.revokeObjectURL(url);
    } catch (e) { toast((e as Error).message); }
  };

  const selTrigger = ruleMeta.triggers.find((t) => t.id === ruleForm.trigger);
  const selAction = ruleMeta.actions.find((a) => a.id === ruleForm.action);
  /** option lists for select-typed match keys + action fields */
  const optsFor = (key: string): { id: string; label: string }[] =>
    key === "formId" ? forms.map((f) => ({ id: f.id, label: f.title }))
    : key === "libraryId" ? libs.map((l) => ({ id: l.id, label: l.name }))
    : key === "status" ? ["todo", "doing", "done"].map((s) => ({ id: s, label: s }))
    : key === "dow" ? ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d, i) => ({ id: String(i), label: d }))
    : [];

  const createRule = async () => {
    try {
      const cfg = Object.fromEntries(Object.entries(ruleForm.cfg).filter(([, v]) => v !== ""));
      const match = Object.fromEntries(Object.entries(ruleForm.match).filter(([, v]) => v !== ""));
      await api.post("/api/rules", {
        name: ruleForm.name.trim() || `${selTrigger?.label ?? "Rule"} → ${selAction?.label ?? ruleForm.action}`,
        trigger: ruleForm.trigger, match: Object.keys(match).length ? match : null,
        action: ruleForm.action, config: cfg,
      });
      setRuleForm({ ...ruleForm, name: "", match: {}, cfg: {} });
      const r = await api.get<{ rules: Rule[] }>("/api/rules");
      setRules(r.rules);
      toast("Automation created");
    } catch (e) { toast((e as Error).message); }
  };
  const loadRuns = async (r: Rule) => {
    if (runsFor === r.id) { setRunsFor(null); return; }
    try {
      const res = await api.get<{ runs: typeof runs }>(`/api/rules/${r.id}/runs`);
      setRuns(res.runs);
      setRunsFor(r.id);
    } catch (e) { toast((e as Error).message); }
  };
  const toggleRule = async (r: Rule) => {
    try {
      await api.patch(`/api/rules/${r.id}`, { enabled: !r.enabled });
      setRules((rs) => rs.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)));
    } catch (e) { toast((e as Error).message); }
  };
  const delRule = async (r: Rule) => {
    if (!confirm(`Delete automation "${r.name}"?`)) return;
    try {
      await api.del(`/api/rules/${r.id}`);
      setRules((rs) => rs.filter((x) => x.id !== r.id));
    } catch (e) { toast((e as Error).message); }
  };
  const ruleDesc = (r: Rule) => {
    const t = ruleMeta.triggers.find((x) => x.id === r.trigger)?.label ?? r.trigger;
    const scope = r.match && Object.values(r.match)[0]
      ? ` (${matchLabelFor(r)})` : "";
    const a = ruleMeta.actions.find((x) => x.id === r.action)?.label ?? r.action;
    return `${t}${scope} → ${a}`;
  };
  const matchLabelFor = (r: Rule) => {
    const v = Object.values(r.match ?? {})[0];
    if (r.trigger === "form.submitted") return forms.find((f) => f.id === v)?.title ?? v;
    if (r.trigger === "file.created") return libs.find((l) => l.id === v)?.name ?? v;
    return v;
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
            <label className="pol-row">
              <select
                value={policies.dlpOnSave ?? "off"}
                onChange={(e) => patchPolicy({ dlpOnSave: e.target.value as Policies["dlpOnSave"] })}
              >
                <option value="off">Off</option>
                <option value="flag">Flag only</option>
                <option value="block">Block save</option>
              </select>
              <span>
                <b>DLP on save</b>
                <em>"Flag" marks matching files + audit row; "Block" rejects the save entirely.</em>
              </span>
            </label>
            <label className="pol-row">
              <input
                type="checkbox"
                checked={policies.watermarkConfidentialExports ?? false}
                onChange={(e) => patchPolicy({ watermarkConfidentialExports: e.target.checked })}
              />
              <span>
                <b>Watermark Confidential/Restricted exports</b>
                <em>Exported copies get a label + timestamp footer stamped by the download pipeline.</em>
              </span>
            </label>
            <label className="pol-row" style={{ alignItems: "stretch", flexDirection: "column" }}>
              <span>
                <b>Allowed IP ranges (conditional access)</b>
                <em>CIDR or literal IPs, one per line — members can only reach the API from these
                  networks. Empty = no restriction. Owners/admins included, so keep your own IP in
                  the list.</em>
              </span>
              <textarea
                rows={2}
                defaultValue={(policies.allowedIpRanges ?? []).join("\n")}
                placeholder={"203.0.113.0/24\n198.51.100.7"}
                onBlur={(e) => {
                  const ranges = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 50);
                  if (ranges.join("\n") !== (policies.allowedIpRanges ?? []).join("\n")) {
                    void patchPolicy({ allowedIpRanges: ranges });
                  }
                }}
                style={{ fontFamily: "monospace", fontSize: 12, border: "1px solid var(--line)", borderRadius: 8, padding: 8 }}
              />
            </label>
            <label className="pol-row">
              <input type="checkbox"
                checked={policies.requireDesktopClient ?? false}
                onChange={(e) => patchPolicy({ requireDesktopClient: e.target.checked })} />
              <span>
                <b>Require desktop app (device posture)</b>
                <em>Web and mobile sessions are rejected — members must use the Kreatix
                  desktop client. Existing web tokens stop working when enabled.</em>
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

      {/* ── Legal holds + eDiscovery ── */}
      {isOwnerOrAdmin && (
        <section className="admin-card">
          <h2>Legal holds</h2>
          <p className="d-sub" style={{ marginTop: 0 }}>
            Held items can't be trashed, purged, or swept by retention — until the hold is released.
          </p>
          <div className="cal-formrow" style={{ marginBottom: 10 }}>
            <input placeholder="Hold name (e.g. Matter 2026-014)" value={holdName}
              onChange={(e) => setHoldName(e.target.value)} style={{ flex: 1 }} />
            <button className="btn-primary btn-sm" disabled={!holdName.trim()}
              onClick={async () => {
                try {
                  await api.post("/api/admin/holds", { name: holdName.trim() });
                  setHoldName(""); void load(); toast("Hold created");
                } catch (e) { toast((e as Error).message); }
              }}>New hold</button>
          </div>
          {holds.map((h) => (
            <div key={h.id} className="chat-person" style={{ cursor: "default" }}>
              <span className="chat-item-main">
                <b>{h.name}</b>
                <span className="d-sub">{h.itemCount} item{h.itemCount === 1 ? "" : "s"} · {h.active ? "active" : "released"} · by {h.createdBy}</span>
              </span>
              <button className="btn-ghost btn-sm" onClick={async () => {
                if (holdOpen === h.id) { setHoldOpen(null); return; }
                setHoldOpen(h.id);
                const [ri, rc] = await Promise.all([
                  api.get<{ items: typeof holdItems }>(`/api/admin/holds/${h.id}/items`).catch(() => null),
                  api.get<{ custodians: typeof holdCusts }>(`/api/admin/holds/${h.id}/custodians`).catch(() => null),
                ]);
                setHoldItems(ri?.items ?? []);
                setHoldCusts(rc?.custodians ?? []);
                setCustPick("");
              }}>{holdOpen === h.id ? "Hide" : `${h.itemCount} items`}</button>
              <button className="btn-ghost btn-sm" title="Matter-scoped export" onClick={async () => {
                try {
                  const bundle = await api.get<Record<string, unknown>>(`/api/admin/holds/${h.id}/export`);
                  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = `matter-${h.name.replace(/[^a-z0-9.-]+/gi, "_")}.json`;
                  a.click(); URL.revokeObjectURL(url);
                } catch (e) { toast((e as Error).message); }
              }}>Export</button>
              <button className="btn-ghost btn-sm" onClick={async () => {
                try { await api.patch(`/api/admin/holds/${h.id}`, { active: !h.active }); void load(); }
                catch (e) { toast((e as Error).message); }
              }}>{h.active ? "Release" : "Reactivate"}</button>
              {holdOpen === h.id && (
                <div style={{ flexBasis: "100%", padding: "4px 0 8px" }}>
                  <div className="d-sub" style={{ fontWeight: 600, margin: "2px 0 4px" }}>Custodians — everything they own is preserved</div>
                  {holdCusts.map((c) => (
                    <div key={c.id} className="d-sub" style={{ display: "flex", gap: 8, padding: "2px 0" }}>
                      <span style={{ flex: 1 }}>{c.name} <em>({c.email} · {c.itemCount} items)</em></span>
                      <button className="btn-ghost btn-sm" onClick={async () => {
                        await api.del(`/api/admin/holds/${h.id}/custodians/${c.id}`);
                        setHoldCusts((xs) => xs.filter((x) => x.id !== c.id));
                      }}>remove</button>
                    </div>
                  ))}
                  <div className="cal-formrow" style={{ marginTop: 4 }}>
                    <select value={custPick} onChange={(e) => setCustPick(e.target.value)} style={{ flex: 1 }}>
                      <option value="">Add custodian…</option>
                      {members.filter((m) => !holdCusts.some((c) => c.id === m.id))
                        .map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.email})</option>)}
                    </select>
                    <button className="btn-ghost btn-sm" disabled={!custPick} onClick={async () => {
                      try {
                        await api.post(`/api/admin/holds/${h.id}/custodians`, { userId: custPick });
                        const rc = await api.get<{ custodians: typeof holdCusts }>(`/api/admin/holds/${h.id}/custodians`);
                        setHoldCusts(rc.custodians); setCustPick("");
                      } catch (e) { toast((e as Error).message); }
                    }}>Add</button>
                  </div>
                  <div className="d-sub" style={{ fontWeight: 600, margin: "8px 0 4px" }}>Held items</div>
                  {holdItems.map((i) => (
                    <div key={i.id} className="d-sub" style={{ display: "flex", gap: 8, padding: "2px 0" }}>
                      <span style={{ flex: 1 }}>{i.name} <em>({i.kind} · {i.owner})</em></span>
                      <button className="btn-ghost btn-sm" onClick={async () => {
                        await api.del(`/api/admin/holds/${h.id}/items/${i.id}`);
                        setHoldItems((xs) => xs.filter((x) => x.id !== i.id)); void load();
                      }}>remove</button>
                    </div>
                  ))}
                  {!holdItems.length && <span className="d-sub">No items on this hold yet — use Drive → item menu → "Legal hold".</span>}
                </div>
              )}
            </div>
          ))}
          {!holds.length && <p className="d-sub">No holds. Flag single files from Drive, or create a named hold here and attach items.</p>}

          {sites.length > 0 && (
            <>
              <h3 style={{ fontSize: 13, margin: "16px 0 6px" }}>Site-wide holds</h3>
              <p className="d-sub" style={{ marginTop: 0 }}>Hold an entire site — covers every item in its libraries.</p>
              {sites.map((s) => (
                <div key={s.id} className="chat-person" style={{ cursor: "default" }}>
                  <span className="chat-item-main"><b>{s.name}</b>
                    <span className="d-sub">{s.legalHold ? "held" : "not held"}</span></span>
                  <button className="btn-ghost btn-sm" onClick={async () => {
                    try {
                      await api.patch(`/api/admin/holds/site/${s.id}`, { hold: !s.legalHold });
                      setSites((xs) => xs.map((x) => x.id === s.id ? { ...x, legalHold: !s.legalHold } : x));
                    } catch (e) { toast((e as Error).message); }
                  }}>{s.legalHold ? "Release" : "Hold"}</button>
                </div>
              ))}
            </>
          )}

          <h2 style={{ marginTop: 24 }}>eDiscovery export</h2>
          <p className="d-sub" style={{ marginTop: 0 }}>
            One-click JSON bundle of a member's files, chat, comments, activity, calendar, and tasks.
          </p>
          <div className="cal-formrow">
            <select value={ediscUser} onChange={(e) => setEdiscUser(e.target.value)} style={{ flex: 1 }}>
              <option value="">Pick a custodian…</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.displayName} ({m.email})</option>)}
            </select>
            <button className="btn-primary btn-sm" disabled={!ediscUser} onClick={async () => {
              try {
                const bundle = await api.get<Record<string, unknown>>(`/api/admin/ediscovery/export/${ediscUser}`);
                const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                const who = members.find((m) => m.id === ediscUser)?.email ?? "user";
                a.href = url; a.download = `ediscovery-${who}-${Date.now()}.json`;
                a.click(); URL.revokeObjectURL(url);
                toast("Export downloaded");
              } catch (e) { toast((e as Error).message); }
            }}>Export JSON</button>
          </div>
        </section>
      )}

      {/* ── DLP engine: rules + violation queue ── */}
      {isOwnerOrAdmin && (
        <section className="admin-card">
          <h2>DLP rules</h2>
          <p className="d-sub" style={{ marginTop: 0 }}>
            Named rules scanned by the pipeline on file saves, text uploads, and chat posts.
            "Block" rejects the write outright; "flag" records a reviewable violation.
          </p>
          {dlpRules.map((r) => (
            <div key={r.id} className="chat-person" style={{ cursor: "default" }}>
              <span className="chat-item-main">
                <b>{r.name}</b>
                <span className="d-sub"><code>/{r.pattern}/i</code> · {r.severity} · {r.action} · {r.applies_to}{!r.enabled ? " · disabled" : ""}</span>
              </span>
              <button className="btn-ghost btn-sm" onClick={async () => {
                try { await api.patch(`/api/admin/dlp/rules/${r.id}`, { enabled: !r.enabled }); void load(); }
                catch (e) { toast((e as Error).message); }
              }}>{r.enabled ? "Disable" : "Enable"}</button>
              <button className="btn-ghost btn-sm" onClick={async () => {
                if (!confirm(`Delete rule "${r.name}"?`)) return;
                await api.del(`/api/admin/dlp/rules/${r.id}`); void load();
              }}>Delete</button>
            </div>
          ))}
          <div className="cal-formrow" style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}>
            <input placeholder="Rule name" value={dlpForm.name}
              onChange={(e) => setDlpForm({ ...dlpForm, name: e.target.value })} style={{ flex: 1, minWidth: 120 }} />
            <input placeholder="/regex/" value={dlpForm.pattern}
              onChange={(e) => setDlpForm({ ...dlpForm, pattern: e.target.value })}
              style={{ flex: 2, minWidth: 160, fontFamily: "monospace" }} />
            <select value={dlpForm.severity} onChange={(e) => setDlpForm({ ...dlpForm, severity: e.target.value })}>
              <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
            </select>
            <select value={dlpForm.action} onChange={(e) => setDlpForm({ ...dlpForm, action: e.target.value })}>
              <option value="flag">flag</option><option value="block">block</option>
            </select>
            <select value={dlpForm.appliesTo} onChange={(e) => setDlpForm({ ...dlpForm, appliesTo: e.target.value })}>
              <option value="files">files</option><option value="chat">chat</option><option value="all">all</option>
            </select>
            <button className="btn-primary btn-sm" disabled={!dlpForm.name.trim() || !dlpForm.pattern.trim()}
              onClick={async () => {
                try {
                  await api.post("/api/admin/dlp/rules", dlpForm);
                  setDlpForm({ name: "", pattern: "", severity: "medium", action: "flag", appliesTo: "files" });
                  void load(); toast("Rule added");
                } catch (e) { toast((e as Error).message); }
              }}>Add rule</button>
          </div>

          <h3 style={{ fontSize: 13, margin: "18px 0 6px" }}>Violations</h3>
          <div className="cal-formrow" style={{ gap: 4, marginBottom: 6 }}>
            {(["open", "confirmed", "dismissed"] as const).map((s) => (
              <button key={s} className={dlpTab === s ? "btn-secondary btn-sm" : "btn-ghost btn-sm"}
                onClick={async () => {
                  setDlpTab(s);
                  const r = await api.get<{ events: typeof dlpEvents }>(`/api/admin/dlp/events?status=${s}`).catch(() => null);
                  setDlpEvents(r?.events ?? []);
                }}>{s}</button>
            ))}
          </div>
          {dlpEvents.map((e) => (
            <div key={e.id} className="chat-person" style={{ cursor: "default" }}>
              <span className="chat-item-main">
                <b>{e.rule}</b> <span className="perm-badge">{e.action}</span>
                <span className="d-sub">
                  {e.refType === "chat_message" ? "chat message" : (e.itemName ?? "item")} · {e.actor ?? "?"} · {new Date(e.createdAt).toLocaleString()}
                  {e.excerpt && <><br /><code style={{ fontSize: 11 }}>{e.excerpt}</code></>}
                </span>
              </span>
              {dlpTab === "open" && (
                <>
                  <button className="btn-ghost btn-sm" onClick={async () => {
                    await api.patch(`/api/admin/dlp/events/${e.id}`, { status: "confirmed" });
                    setDlpEvents((xs) => xs.filter((x) => x.id !== e.id));
                  }}>Confirm</button>
                  <button className="btn-ghost btn-sm" onClick={async () => {
                    await api.patch(`/api/admin/dlp/events/${e.id}`, { status: "dismissed" });
                    setDlpEvents((xs) => xs.filter((x) => x.id !== e.id));
                  }}>Dismiss</button>
                </>
              )}
            </div>
          ))}
          {!dlpEvents.length && <p className="d-sub">No {dlpTab} violations.</p>}
        </section>
      )}

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
        <h2>Email domains</h2>
        <p className="d-sub" style={{ marginTop: 0 }}>
          Verify your company domain and new mailboxes are provisioned as <code>name@yourdomain.com</code>.
          Without a verified domain, mailboxes use the default <code>@kreatixtech.com</code>.
        </p>
        <div className="audit-bar">
          <input placeholder="acme.com" value={newDomain} style={{ minWidth: 220 }}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void addDomain()} />
          <button className="btn-primary" disabled={domainBusy === "add" || !newDomain.trim()}
            onClick={() => void addDomain()}>Add domain</button>
        </div>
        {domains.length > 0 && (
          <div className="tbl-scroll"><table className="admin-table" style={{ marginTop: 10 }}>
            <thead><tr><th>Domain</th><th>Status</th><th>Mailbox domain</th><th></th></tr></thead>
            <tbody>
              {domains.map((d) => (
                <Fragment key={d.id}>
                  <tr>
                    <td>
                      <button className="btn-ghost" style={{ padding: 0, fontWeight: 600 }}
                        onClick={() => setOpenDomain(openDomain === d.id ? null : d.id)}>
                        {openDomain === d.id ? "▾" : "▸"} {d.domain}
                      </button>
                    </td>
                    <td>
                      <span className={`role-badge ${d.status === "verified" ? "" : "warn"}`}>
                        {d.status === "verified" ? "✓ verified" : d.status === "failed" ? "✕ failed" : "… pending"}
                      </span>
                      {d.mxOk && <span className="d-sub" style={{ marginLeft: 6 }} title="MX record points at Kreatix Mail">MX ✓</span>}
                      {d.brevoOk && <span className="d-sub" style={{ marginLeft: 6 }} title="DKIM/DMARC authenticated for outbound">signed ✓</span>}
                    </td>
                    <td>{d.isPrimary ? <b>primary</b> : <span className="d-sub">—</span>}</td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      {d.status !== "verified" && (
                        <button className="btn-secondary" style={{ padding: "2px 10px", fontSize: 12 }}
                          disabled={domainBusy === d.id} onClick={() => void verifyDomain(d)}>
                          {domainBusy === d.id ? "Checking…" : "Verify"}
                        </button>
                      )}
                      {d.status === "verified" && !d.isPrimary && (
                        <button className="btn-secondary" style={{ padding: "2px 10px", fontSize: 12 }}
                          disabled={domainBusy === d.id} onClick={() => void setPrimaryDomain(d)}>Set primary</button>
                      )}
                      <button className="btn-ghost" style={{ padding: "2px 8px", fontSize: 12 }}
                        onClick={() => void removeDomain(d)}>Remove</button>
                    </td>
                  </tr>
                  {openDomain === d.id && (
                    <tr><td colSpan={4} style={{ background: "var(--bg, #fafafa)" }}>
                      <table className="admin-table">
                        <thead><tr><th>Type</th><th>Host</th><th>Value</th><th>Purpose</th><th></th></tr></thead>
                        <tbody>
                          {d.dns.map((r, i) => (
                            <tr key={i}>
                              <td><code>{r.type}</code></td>
                              <td><code>{r.host}</code></td>
                              <td><code style={{ wordBreak: "break-all" }}>{r.value}</code></td>
                              <td className="d-sub">
                                {r.purpose}{r.required && " — required"}
                                {r.ok === true && " ✓"}
                              </td>
                              <td><button className="btn-ghost" style={{ padding: "2px 8px", fontSize: 12 }}
                                onClick={() => void copyRec(r.value)}>Copy</button></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <p className="d-sub" style={{ margin: "8px 0 0" }}>
                        Publish these at your DNS provider, wait a few minutes, then click <b>Verify</b>.
                        MX/SPF/DMARC can be added now too — inbound mail for verified domains is accepted once the MX record is live.
                      </p>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table></div>
        )}
        {!domains.length && <div className="empty" style={{ padding: 12 }}>No domains yet.</div>}
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
        <h2>Branding</h2>
        <p className="d-sub" style={{ marginTop: -6 }}>Your workspace's name and logo in the app shell, invite pages and document titles.</p>
        <BrandingCard toast={toast} />
      </section>

      <section className="admin-card">
        <h2>API &amp; webhooks</h2>
        <p className="d-sub" style={{ marginTop: -6 }}>
          Public API base: <code>{PUBLIC_ORIGIN}/api/v1</code> — authenticate with <code>Authorization: Bearer kx_…</code>.
          Keys are org-scoped service principals, not a user's ACL.
        </p>
        <div className="audit-bar" style={{ flexWrap: "wrap" }}>
          <input placeholder="Key name" value={newKey.name}
            onChange={(e) => setNewKey({ ...newKey, name: e.target.value })} style={{ width: 160 }} />
          {["read", "write", "hooks"].map((s) => (
            <label key={s} className="flag" style={{ flex: "0 0 auto" }}>
              <input type="checkbox" checked={newKey.scopes.includes(s)}
                onChange={(e) => setNewKey({ ...newKey, scopes: e.target.checked ? [...newKey.scopes, s] : newKey.scopes.filter((x) => x !== s) })} />
              <span>{s}</span>
            </label>
          ))}
          <button className="btn-secondary" disabled={!newKey.name.trim() || !newKey.scopes.length}
            onClick={async () => {
              try {
                const r = await api.post<{ id: string; token: string }>("/api/admin/api-keys", newKey);
                setFreshKey(r.token); setNewKey({ name: "", scopes: ["read"] });
                await load();
              } catch (e) { toast((e as Error).message); }
            }}>+ API key</button>
        </div>
        {apiKeys.map((k) => (
          <div key={k.id} className="pol-row">
            <span>
              <b>{k.name}</b> <code>{k.prefix}…</code>
              <em style={{ display: "block" }}>
                {k.scopes.join(", ")} · {k.creator ?? "service"} · {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString()}` : "never used"}
              </em>
            </span>
            <button className="btn-ghost" onClick={async () => {
              await api.del(`/api/admin/api-keys/${k.id}`).catch(() => {});
              await load();
            }}>Revoke</button>
          </div>
        ))}
        {freshKey && (
          <div className="pol-row">
            <span>
              <b>Copy this key now — it is shown once:</b>
              <code style={{ display: "block", wordBreak: "break-all", marginTop: 4 }}>{freshKey}</code>
              <button className="btn-secondary" style={{ marginTop: 6 }}
                onClick={() => { void navigator.clipboard.writeText(freshKey); toast("Copied"); }}>Copy</button>
              <button className="btn-ghost" style={{ marginTop: 6, marginLeft: 6 }} onClick={() => setFreshKey("")}>Dismiss</button>
            </span>
          </div>
        )}

        <h3 style={{ marginTop: 18 }}>Outbound webhooks</h3>
        <p className="d-sub">POST a signed JSON payload to your endpoint on suite events (form submissions, file adds, task moves, meeting end). Verify with <code>x-kreatix-signature</code> (HMAC-SHA256).</p>
        <div className="audit-bar" style={{ flexWrap: "wrap" }}>
          <input placeholder="https://example.com/hook" value={hookForm.url}
            onChange={(e) => setHookForm({ ...hookForm, url: e.target.value })} style={{ minWidth: 260 }} />
          <input placeholder="events (comma-sep, blank = all)" value={hookForm.events}
            onChange={(e) => setHookForm({ ...hookForm, events: e.target.value })} style={{ minWidth: 220 }} />
          <button className="btn-secondary" disabled={!hookForm.url.trim()}
            onClick={async () => {
              try {
                const r = await api.post<{ hook: { id: string; secret: string } }>("/api/admin/webhooks", {
                  url: hookForm.url.trim(),
                  events: hookForm.events.split(",").map((s) => s.trim()).filter(Boolean),
                });
                toast(`Webhook added — signing secret ${r.hook.secret.slice(0, 10)}… (shown in list)`);
                setHookForm({ url: "", events: "" });
                await load();
              } catch (e) { toast((e as Error).message); }
            }}>+ Webhook</button>
        </div>
        {webhooks.map((h) => (
          <div key={h.id}>
            <div className="pol-row">
              <span>
                <b style={{ wordBreak: "break-all" }}>{h.url}</b>
                <em style={{ display: "block" }}>
                  {h.events.length ? h.events.join(", ") : "all events"} · {h.active ? "active" : "paused"}
                  {h.failures > 0 && ` · ${h.failures} failed`}
                  {h.last_delivered && ` · last ok ${new Date(h.last_delivered).toLocaleString()}`}
                </em>
              </span>
              <span style={{ display: "flex", gap: 4 }}>
                <button className="btn-ghost btn-sm" onClick={async () => {
                  const r = await api.post<{ ok: boolean; status?: number; error?: string }>(`/api/admin/webhooks/${h.id}/test`, {});
                  toast(r.ok ? `Delivered (${r.status})` : `Failed — ${r.error ?? r.status}`);
                }}>Test</button>
                <button className="btn-ghost btn-sm" onClick={async () => {
                  if (hookOpen === h.id) { setHookOpen(null); return; }
                  const r = await api.get<{ deliveries: typeof hookDeliveries }>(`/api/admin/webhooks/${h.id}/deliveries`);
                  setHookDeliveries(r.deliveries); setHookOpen(h.id);
                }}>Log</button>
                <button className="btn-ghost btn-sm" onClick={async () => {
                  await api.post(`/api/admin/webhooks/${h.id}/toggle`, {}).catch(() => {}); await load();
                }}>{h.active ? "Pause" : "Resume"}</button>
                <button className="btn-ghost btn-sm" onClick={async () => {
                  await api.del(`/api/admin/webhooks/${h.id}`).catch(() => {}); await load();
                }}>Delete</button>
              </span>
            </div>
            {hookOpen === h.id && (
              <div className="tbl-scroll" style={{ marginTop: 4 }}>
                <table className="admin-table">
                  <thead><tr><th>Event</th><th>Status</th><th>Tries</th><th>Code</th><th>At</th></tr></thead>
                  <tbody>
                    {hookDeliveries.map((d) => (
                      <tr key={d.id}>
                        <td>{d.event}</td><td>{d.status}</td><td>{d.attempts}</td>
                        <td>{d.response_code ?? "—"}</td><td>{new Date(d.created_at).toLocaleString()}</td>
                      </tr>
                    ))}
                    {!hookDeliveries.length && <tr><td colSpan={5} className="d-sub">No deliveries yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        {!webhooks.length && <p className="d-sub">No webhooks configured.</p>}
      </section>

      <section className="admin-card">
        <h2>Automations</h2>
        <p className="d-sub" style={{ marginTop: -6 }}>When something happens in one app, do something in another. <code>{"{{name}}"}</code> and other context fields interpolate into titles and messages.</p>
        <div className="audit-bar" style={{ flexWrap: "wrap", marginBottom: 8 }}>
          <input placeholder="Rule name" value={ruleForm.name}
            onChange={(e) => setRuleForm({ ...ruleForm, name: e.target.value })} style={{ minWidth: 180 }} />
          <select value={ruleForm.trigger} onChange={(e) => setRuleForm({ ...ruleForm, trigger: e.target.value, match: {} })}>
            {ruleMeta.triggers.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          {(selTrigger?.matchKeys ?? []).map((mk) =>
            mk.kind === "number" ? (
              <input key={mk.key} type="number" min={0} placeholder={mk.label}
                value={ruleForm.match[mk.key] ?? ""}
                onChange={(e) => setRuleForm({ ...ruleForm, match: { ...ruleForm.match, [mk.key]: e.target.value } })}
                style={{ width: 170 }} />
            ) : (
              <select key={mk.key} value={ruleForm.match[mk.key] ?? ""}
                onChange={(e) => setRuleForm({ ...ruleForm, match: { ...ruleForm.match, [mk.key]: e.target.value } })}>
                <option value="">{mk.label} — any</option>
                {optsFor(mk.key).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
              </select>
            ))}
          <span style={{ color: "var(--muted)" }}>→</span>
          <select value={ruleForm.action} onChange={(e) => setRuleForm({ ...ruleForm, action: e.target.value, cfg: {} })}>
            {ruleMeta.actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </select>
        </div>
        <div className="audit-bar" style={{ flexWrap: "wrap", marginBottom: 12 }}>
          {(selAction?.fields ?? []).map((f) =>
            f.kind === "textarea" ? (
              <input key={f.key} placeholder={`${f.label} — {{vars}} ok`} value={ruleForm.cfg[f.key] ?? ""}
                onChange={(e) => setRuleForm({ ...ruleForm, cfg: { ...ruleForm.cfg, [f.key]: e.target.value } })}
                style={{ minWidth: 220 }} />
            ) : f.kind === "user" ? (
              <select key={f.key} value={ruleForm.cfg[f.key] ?? ""}
                onChange={(e) => setRuleForm({ ...ruleForm, cfg: { ...ruleForm.cfg, [f.key]: e.target.value } })}>
                <option value="">{f.label} — none</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
              </select>
            ) : f.kind === "library" ? (
              <select key={f.key} value={ruleForm.cfg[f.key] ?? ""}
                onChange={(e) => setRuleForm({ ...ruleForm, cfg: { ...ruleForm.cfg, [f.key]: e.target.value } })}>
                <option value="">{f.label}</option>
                {libs.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            ) : f.kind === "status" ? (
              <select key={f.key} value={ruleForm.cfg[f.key] ?? ""}
                onChange={(e) => setRuleForm({ ...ruleForm, cfg: { ...ruleForm.cfg, [f.key]: e.target.value } })}>
                <option value="">{f.label}</option>
                {["todo", "doing", "done"].map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            ) : f.kind === "bool" ? (
              <label key={f.key} style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={ruleForm.cfg[f.key] === "true"}
                  onChange={(e) => setRuleForm({ ...ruleForm, cfg: { ...ruleForm.cfg, [f.key]: e.target.checked ? "true" : "" } })} />
                {f.label}
              </label>
            ) : (
              <input key={f.key} type={f.kind === "number" ? "number" : "text"} placeholder={`${f.label} — {{vars}} ok`}
                value={ruleForm.cfg[f.key] ?? ""}
                onChange={(e) => setRuleForm({ ...ruleForm, cfg: { ...ruleForm.cfg, [f.key]: e.target.value } })}
                style={{ minWidth: f.kind === "number" ? 100 : 180 }} />
            ))}
          <button className="btn-primary btn-sm" onClick={() => void createRule()}>Add rule</button>
        </div>
        <div className="tbl-scroll"><table className="admin-table">
          <thead><tr><th>Rule</th><th>Flow</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rules.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td>
                    <button className="btn-ghost" style={{ padding: 0, fontWeight: 600 }}
                      onClick={() => void loadRuns(r)} title="Show recent runs">
                      {runsFor === r.id ? "▾" : "▸"} {r.name}
                    </button>
                  </td>
                  <td style={{ color: "var(--sub)" }}>{ruleDesc(r)}</td>
                  <td>
                    <button className="btn-ghost btn-sm" onClick={() => void toggleRule(r)}>
                      {r.enabled ? "● on" : "○ off"}
                    </button>
                  </td>
                  <td><button className="btn-ghost btn-sm danger" onClick={() => void delRule(r)}>Delete</button></td>
                </tr>
                {runsFor === r.id && (
                  <tr><td colSpan={4} style={{ background: "var(--bg, #fafafa)" }}>
                    {runs.length ? (
                      <table className="admin-table">
                        <thead><tr><th>When</th><th>Result</th><th>Detail</th></tr></thead>
                        <tbody>
                          {runs.map((rn, i) => (
                            <tr key={i}>
                              <td style={{ whiteSpace: "nowrap" }}>{new Date(rn.fired_at).toLocaleString()}</td>
                              <td>{rn.ok === null ? "…" : rn.ok ? "✓ ran" : "✕ failed"}</td>
                              <td className="d-sub" style={{ wordBreak: "break-all" }}>
                                {rn.detail ? Object.entries(rn.detail).map(([k, v]) => `${k}=${v}`).join("  ") : "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : <p className="d-sub">No runs yet.</p>}
                  </td></tr>
                )}
              </Fragment>
            ))}
            {!rules.length && (
              <tr><td colSpan={4} style={{ color: "var(--sub)", textAlign: "center" }}>No automations yet — e.g. "Form response → create task".</td></tr>
            )}
          </tbody>
        </table></div>
      </section>

      <section className="admin-card">
        <h2>Audit log</h2>
        <div className="audit-bar" style={{ flexWrap: "wrap" }}>
          <select value={auditAction} onChange={(e) => setAuditAction(e.target.value)} title="Action">
            <option value="">All actions</option>
            {auditActions.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select value={auditUser} onChange={(e) => setAuditUser(e.target.value)} title="Actor">
            <option value="">All users</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
          <input type="date" value={auditFrom} onChange={(e) => setAuditFrom(e.target.value)} title="From" />
          <input type="date" value={auditTo} onChange={(e) => setAuditTo(e.target.value)} title="To" />
          <button className="btn-secondary" onClick={() => void reloadAudit()}>Apply</button>
          <button className="btn-ghost" onClick={() => void exportAudit()}>Export CSV</button>
          <input
            placeholder="Search results…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
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

/** White-label controls — org display name + logo (PNG/JPEG/SVG/WebP ≤512KB). */
function BrandingCard({ toast }: { toast: (m: string) => void }) {
  const { org, refreshUser } = useAuth();
  const [name, setName] = useState(org?.brandName ?? "");
  const [logoUrl, setLogoUrl] = useState(org?.logoUrl ?? null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setName(org?.brandName ?? ""); setLogoUrl(org?.logoUrl ?? null); }, [org]);

  const saveName = async () => {
    setBusy(true);
    try {
      await api.put("/api/admin/branding", { name: name.trim() });
      await refreshUser();
      toast("Branding saved");
    } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };

  const uploadLogo = async (f: File) => {
    setBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/branding/logo`, {
        method: "POST",
        headers: { authorization: `Bearer ${getToken() ?? ""}`, "content-type": f.type },
        body: f,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? `HTTP ${res.status}`);
      await refreshUser();
      setLogoUrl((await res.json()).logoUrl);
      toast("Logo updated");
    } catch (e) { toast((e as Error).message); }
    setBusy(false);
  };

  return (
    <div className="audit-bar" style={{ flexWrap: "wrap", alignItems: "center" }}>
      {logoUrl && <img src={logoUrl} alt="org logo" style={{ height: 34, width: "auto", borderRadius: 6, background: "#fff" }} />}
      <input placeholder="Workspace name (blank = Kreatix Suites)" value={name}
        onChange={(e) => setName(e.target.value)} style={{ minWidth: 220 }} />
      <label className="btn-secondary" style={{ cursor: "pointer" }}>
        {busy ? "…" : "Upload logo"}
        <input type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadLogo(f); e.target.value = ""; }} />
      </label>
      {logoUrl && (
        <button className="btn-ghost" onClick={async () => {
          await api.del("/api/admin/branding/logo").catch(() => {});
          await refreshUser(); setLogoUrl(null);
        }}>Remove logo</button>
      )}
      <button className="btn-primary" disabled={busy} onClick={() => void saveName()}>Save</button>
    </div>
  );
}
