import { useState } from "react";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useToast } from "../lib/hooks";
import { Modal } from "./Modal";

// First-run setup for a new workspace — shown once to owner/admins until the
// org is onboarded. Steps mirror the Microsoft-style flow: domain → people →
// done. Every step is skippable; "Set up later" only dismisses for the session.

interface AddedDomain {
  id: string; domain: string; status: string;
  mxOk?: boolean; spfOk?: boolean; dmarcOk?: boolean; brevoOk?: boolean;
  dns: { type: string; host: string; value: string; purpose: string; required?: boolean; ok?: boolean | null }[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function OnboardingWizard({ onClose }: { onClose: () => void }) {
  const { org, markOnboarded } = useAuth();
  const { msg, toast } = useToast();
  const [step, setStep] = useState(0);
  const [domainInput, setDomainInput] = useState("");
  const [added, setAdded] = useState<AddedDomain | null>(null);
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState(0);
  const [verifyMsg, setVerifyMsg] = useState<string | null>(null);
  const [mxTargets, setMxTargets] = useState<string[] | null>(null);

  const finish = async () => {
    await api.post("/api/admin/onboarding", {}).catch(() => {});
    markOnboarded();
    onClose();
  };

  const addDomain = async () => {
    const domain = domainInput.trim().toLowerCase();
    if (!domain) return;
    setBusy(true);
    setVerifyMsg(null);
    try {
      const r = await api.post<{ domain: AddedDomain }>("/api/admin/domains", { domain });
      setAdded(r.domain);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Could not add domain");
    }
    setBusy(false);
  };

  const verifyDomain = async () => {
    if (!added) return;
    setBusy(true);
    setVerifyMsg(null);
    try {
      const r = await api.post<{ domain: AddedDomain }>(`/api/admin/domains/${added.id}/verify`, {});
      setAdded(r.domain);
      if (r.domain.status === "verified") {
        setVerifyMsg(`✓ ${r.domain.domain} verified — team mailboxes will use it.`);
        // make it primary so member mailboxes land on it from day one
        await api.post(`/api/admin/domains/${added.id}/primary`, {}).catch(() => {});
      }
    } catch (e) {
      setVerifyMsg(e instanceof Error ? e.message : "Verification failed — try again in a few minutes");
    }
    setBusy(false);
  };

  /** Live re-check of every record — powers the "check now" buttons and the
   *  cutover detection (where mail currently flows). */
  const checkRecords = async () => {
    if (!added) return;
    setBusy(true);
    try {
      const r = await api.post<{ domain: AddedDomain; mxTargets: string[]; verified: boolean }>(
        `/api/admin/domains/${added.id}/check`, {});
      setAdded(r.domain);
      setMxTargets(r.mxTargets);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Check failed");
    }
    setBusy(false);
  };

  const sendInvites = async () => {
    const list = emails.split(/[\s,;]+/).filter((e) => EMAIL_RE.test(e));
    if (!list.length) { setStep(3); return; }
    setBusy(true);
    let sent = 0;
    for (const email of list) {
      try {
        const r = await api.post<{ emailed?: boolean }>("/api/admin/invites", { email });
        sent++;
        void r;
      } catch { /* invite failed for that address — keep going */ }
    }
    setInvited(sent);
    setBusy(false);
    setStep(3);
  };

  const steps = ["Welcome", "Email domain", "Your team", "Done"];

  return (
    <Modal label="Set up your workspace" onClose={() => { sessionStorage.setItem("kx.ob.dismiss", "1"); onClose(); }}
      style={{ width: 560, maxWidth: "94vw" }}>
      <div className="ob-steps">
        {steps.map((s, i) => (
          <span key={s} className={`ob-dot ${i === step ? "on" : ""} ${i < step ? "done" : ""}`}>{s}</span>
        ))}
      </div>

      {step === 0 && (
        <div className="ob-body">
          <h3>Welcome to {org?.name || "your workspace"}</h3>
          <p className="d-sub">
            A couple of quick steps to get your company set up — connect your email domain
            and bring your team in. Everything here can also be done later from <b>Admin</b>.
          </p>
          <div className="dlg-actions">
            <button className="btn-ghost" onClick={() => { sessionStorage.setItem("kx.ob.dismiss", "1"); onClose(); }}>Set up later</button>
            <button className="btn-primary" onClick={() => setStep(1)}>Get started</button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="ob-body">
          <h3>Your email domain</h3>
          {!added ? (
            <>
              <p className="d-sub">
                Use your company domain for mail — e.g. <code>you@acme.com</code>. You'll prove
                ownership with a DNS record. Or skip and everyone gets <code>@kreatixtech.com</code> addresses.
              </p>
              <div className="audit-bar">
                <input placeholder="acme.com" value={domainInput} style={{ flex: 1 }}
                  onChange={(e) => setDomainInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addDomain()} />
                <button className="btn-primary" disabled={busy || !domainInput.trim()} onClick={() => void addDomain()}>
                  {busy ? "Adding…" : "Add domain"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="d-sub">
                <b>{added.domain}</b> added{added.status === "verified" ? " and verified" : ""}.
                Publish these records at your DNS provider, then verify below — team mailboxes
                will use this domain once verified.
              </p>
              <table className="admin-table" style={{ marginTop: 6 }}>
                <tbody>
                  {added.dns.map((r, i) => (
                    <tr key={i}>
                      <td><code>{r.type}</code></td>
                      <td><code>{r.host}</code></td>
                      <td><code style={{ wordBreak: "break-all" }}>{r.value}</code></td>
                      <td style={{ whiteSpace: "nowrap", fontSize: 11 }}>
                        {r.ok === true ? "✓" : r.ok === false ? "⏳" : ""}
                        {r.required ? " required" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {mxTargets !== null && (
                <p style={{ fontSize: 12.5, margin: "8px 0 0" }}>
                  {mxTargets.length === 0
                    ? "No MX record yet — mail won't arrive until you add it."
                    : added.mxOk
                      ? "✓ Kreatavi already routes to Kreatix."
                      : <>Kreatavi currently flows to <b>{mxTargets[0]}</b> — it switches to Kreatix when you point MX at <code>mail.kreatixtech.com</code>.</>}
                </p>
              )}
              {verifyMsg && <p style={{ fontSize: 12.5, margin: "8px 0 0" }}>{verifyMsg}</p>}
            </>
          )}
          <div className="dlg-actions">
            <button className="btn-ghost" onClick={() => setStep(2)}>
              {added ? (added.status === "verified" ? "Continue" : "Verify later — continue") : "Skip — use @kreatixtech.com"}
            </button>
            {added && added.status !== "verified" && (
              <button className="btn-primary" disabled={busy} onClick={() => void verifyDomain()}>
                {busy ? "Checking DNS…" : "Verify domain"}
              </button>
            )}
            {added && (
              <button className="btn-ghost" disabled={busy} onClick={() => void checkRecords()}>
                {busy ? "Checking…" : "Re-check records"}
              </button>
            )}
            {added?.status === "verified" && (
              <button className="btn-primary" onClick={() => setStep(2)}>Continue</button>
            )}
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="ob-body">
          <h3>Bring your team in</h3>
          <p className="d-sub">
            Email addresses, separated by commas or new lines — each person gets an invite.
            {added?.status === "verified"
              ? <> Their <code>name@{added.domain}</code> mailbox is created the moment they accept.</>
              : " Their mailbox is created the moment they accept."}
          </p>
          <textarea rows={4} placeholder="jane@acme.com, kwame@acme.com" value={emails}
            onChange={(e) => setEmails(e.target.value)} style={{ width: "100%" }} />
          <div className="dlg-actions">
            <button className="btn-ghost" onClick={() => setStep(3)}>Skip for now</button>
            <button className="btn-primary" disabled={busy} onClick={() => void sendInvites()}>
              {busy ? "Sending…" : "Send invites"}
            </button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="ob-body">
          <h3>You're all set</h3>
          {added?.status === "verified" && (
            <ul className="d-sub" style={{ lineHeight: 1.9 }}>
              <li>{added.mxOk ? "✓ MX points at Kreatix — mail arrives here."
                             : <>MX not pointed yet — publish <code>MX → mail.kreatixtech.com</code> to start receiving mail.</>}</li>
              <li>{added.spfOk ? "✓ SPF published." : "SPF record not found yet — needed so your outbound mail isn't spam-foldered."}</li>
              <li>{added.brevoOk ? "✓ DKIM signing authenticated." : "DKIM/DMARC records pending — see Admin → Email domains."}</li>
            </ul>
          )}
          <ul className="d-sub" style={{ lineHeight: 1.9 }}>
            <li>{added?.status === "verified"
                       ? <>Domain <b>{added.domain}</b> verified — member mailboxes will use it.</>
                       : added
                       ? <>Domain <b>{added.domain}</b> — finish DNS verification in <b>Admin → Email domains</b>.</>
                       : <>Mailboxes will use <code>@kreatixtech.com</code> — add a custom domain anytime in <b>Admin → Email domains</b>.</>}</li>
            <li>{invited > 0 ? <>{invited} invite{invited > 1 ? "s" : ""} sent — teammates join from their email.</>
                             : <>Invite teammates anytime from <b>Admin → Members</b>.</>}</li>
            <li>Kreatavi is in the left rail — the first visit creates your mailbox automatically.</li>
            <li>Migrating from Microsoft 365? <b>Admin → Microsoft 365 import</b> pulls every mailbox over.</li>
          </ul>
          <div className="dlg-actions">
            <button className="btn-primary" onClick={() => void finish()}>Done</button>
          </div>
        </div>
      )}

      {msg && <div className="toast" role="status">{msg}</div>}
    </Modal>
  );
}
