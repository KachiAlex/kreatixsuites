// Weekly site digests — for every site with activity in the last 7 days,
// each member gets an email summarizing what changed (SharePoint's
// "site digest" / OneDrive weekly digest, but derived from our audit log).
import { one, q } from "./db.js";
import { mailEnabled, publicUrl, sendMail } from "./email.js";
import { decryptField } from "./crypto.js";

interface SiteRow { id: string; org_id: string; name: string }
interface EventRow {
  id: string; action: string; detail: string | null; file_id: string | null;
  actor_name: string; created_at: string;
}
interface MemberRow { user_id: string; email: string; display_name: string; email_verified: boolean }
interface ItemRow { id: string; name: string; library_id: string; updated_at: string }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function digestHtml(siteId: string, siteName: string, orgName: string, memberName: string,
  events: EventRow[], items: ItemRow[]): { subject: string; html: string } {
  const evRows = events.slice(0, 12).map((e) =>
    `<tr><td style="padding:5px 10px 5px 0;color:#8a8a90;font-size:12px;white-space:nowrap">${new Date(e.created_at).toDateString()}</td>` +
    `<td style="padding:5px 0;font-size:13px"><b>${esc(e.actor_name)}</b> ${esc(e.action)}${e.detail ? ` — ${esc(e.detail)}` : ""}</td></tr>`).join("");
  const itemRows = items.slice(0, 8).map((it) =>
    `<tr><td style="padding:5px 10px 5px 0;font-size:13px"><a href="${publicUrl()}/edit/${it.id}" style="color:#F2782E;text-decoration:none">${esc(it.name)}</a></td>` +
    `<td style="padding:5px 0;font-size:12px;color:#8a8a90">${new Date(it.updated_at).toDateString()}</td></tr>`).join("");
  const body = `
<p>Hi ${esc(memberName)},</p>
<p>Here's what happened last week in <b>${esc(siteName)}</b>${orgName ? ` (${esc(orgName)})` : ""}.</p>
${items.length ? `<h2 style="font-size:14px;margin:20px 0 6px">Recently updated</h2>
<table style="border-collapse:collapse">${itemRows}</table>` : ""}
${events.length ? `<h2 style="font-size:14px;margin:20px 0 6px">Activity (${events.length})</h2>
<table style="border-collapse:collapse">${evRows}</table>
${events.length > 12 ? `<p style="font-size:12px;color:#8a8a90">…and ${events.length - 12} more events.</p>` : ""}` : ""}
<a href="${publicUrl()}/sites/${siteId}" style="display:inline-block;background:#F2782E;color:#fff;text-decoration:none;font-weight:600;font-size:14px;border-radius:8px;padding:11px 22px;margin:14px 0 4px">Open ${esc(siteName)}</a>
<p style="color:#8a8a90;font-size:12px;margin-top:22px">Weekly digest for site members. Turn off per-site alerts in Site settings to reduce mail.</p>`;
  return {
    subject: `${siteName} — weekly digest`,
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#f6f6f7;font-family:Inter,Segoe UI,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f7;padding:32px 16px"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e8e8ea">
<tr><td style="background:#1c1c1e;padding:20px 28px">
  <span style="display:inline-block;background:#F2782E;color:#fff;font-weight:700;font-size:13px;border-radius:6px;padding:4px 8px;margin-right:8px">K</span>
  <span style="color:#fff;font-weight:600;font-size:15px;letter-spacing:.2px">Kreatix Suites</span>
</td></tr>
<tr><td style="padding:28px;color:#1c1c1e;font-size:14px;line-height:1.6">
<h1 style="margin:0 0 14px;font-size:18px;font-weight:700">${esc(siteName)} — this week</h1>
${body}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eee;color:#8a8a90;font-size:12px">
Kreatix Suites · <a href="${publicUrl()}" style="color:#F2782E;text-decoration:none">${publicUrl().replace(/^https?:\/\//, "")}</a>
</td></tr>
</table></td></tr></table></body></html>`,
  };
}

/** Called from the daily sweep; self-gates to once every 6.5 days. */
export async function sweepSiteDigests(log: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void }): Promise<string> {
  if (!mailEnabled()) return "skipped — KREATIX_BREVO_API_KEY not set";
  const last = await one<{ last_run: string }>(
    "SELECT last_run FROM sweep_state WHERE name = 'sites.digest.send' AND ok", []);
  if (last && Date.now() - Date.parse(last.last_run) < 6.5 * 24 * 3600 * 1000)
    return "skipped — sent within the last 6.5 days";

  const sites = await q<SiteRow>(`SELECT id, org_id, name FROM sites`);
  let sent = 0;
  let skipped = 0;
  for (const site of sites) {
    // Same scoping as /api/sites/:id/activity — site events + file events in
    // the site's libraries — restricted to the last 7 days.
    const events = await q<EventRow>(
      `SELECT a.id, a.action, a.detail, a.file_id, a.created_at,
              COALESCE(u.display_name, 'Someone') AS actor_name
         FROM activity a LEFT JOIN users u ON u.id = a.actor_id
        WHERE a.org_id = $2 AND a.created_at > now() - interval '7 days' AND (
          a.site_id = $1
          OR a.file_id IN (SELECT i.id FROM items i JOIN libraries l ON l.id = i.library_id
                           WHERE l.site_id = $1))
        ORDER BY a.created_at DESC LIMIT 50`, [site.id, site.org_id]);
    if (!events.length) { skipped++; continue; }

    const items = await q<ItemRow>(
      `SELECT i.id, i.name, i.library_id, i.updated_at
         FROM items i JOIN libraries l ON l.id = i.library_id
        WHERE l.site_id = $1 AND NOT i.trashed AND i.kind <> 'folder'
        ORDER BY i.updated_at DESC LIMIT 8`, [site.id]);
    items.forEach((it) => { it.name = decryptField(it.name) ?? it.name; });
    events.forEach((e) => { if (e.detail) e.detail = decryptField(e.detail) ?? e.detail; });

    const members = await q<MemberRow>(
      `SELECT m.user_id, u.email, u.display_name, u.email_verified
         FROM site_members m JOIN users u ON u.id = m.user_id
        WHERE m.site_id = $1 AND NOT u.disabled`, [site.id]);
    const org = await one<{ name: string }>("SELECT name FROM orgs WHERE id = $1", [site.org_id]);

    for (const m of members) {
      if (!m.email_verified) continue; // unverified addresses opted out of email
      const tpl = digestHtml(site.id, site.name, org?.name ?? "", m.display_name, events, items);
      try {
        await sendMail({ to: m.email, toName: m.display_name, subject: tpl.subject, html: tpl.html });
        sent++;
      } catch (e) {
        log.warn({ err: String(e), to: m.email, site: site.id }, "site digest send failed");
      }
    }
  }
  const detail = `digests sent: ${sent}, sites skipped (quiet): ${skipped}`;
  log.info(detail, "site digest sweep complete");
  // Record the send run separately so the outer sweep wrapper's row doesn't
  // reset the 6.5-day clock every daily tick.
  await q(`INSERT INTO sweep_state (name, last_run, ok, detail) VALUES ('sites.digest.send', now(), true, $1)
           ON CONFLICT (name) DO UPDATE SET last_run = now(), ok = true, detail = $1`, [detail]);
  return detail;
}
