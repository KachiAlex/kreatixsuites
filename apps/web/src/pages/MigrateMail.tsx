import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { MailImportTool } from "../components/MailImportTool";

type Source = "google" | "microsoft" | "other";

const SOURCES: { id: Source; label: string }[] = [
  { id: "google", label: "Google Workspace / Gmail" },
  { id: "microsoft", label: "Microsoft 365 / Outlook" },
  { id: "other", label: "Other webmail" },
];

const STEPS: Record<Source, { title: string; steps: ReactNode[] }> = {
  google: {
    title: "Export from Google",
    steps: [
      <>Open <b>takeout.google.com</b> and sign in as the account you are moving.</>,
      <>Click <b>Deselect all</b>, then tick only <b>Mail</b>.</>,
      <>Click <b>Next step</b>. Choose the <b>.zip</b> format. Splitting into several parts is fine.</>,
      <>Click <b>Create export</b>. Google emails a download link when it is ready — large mailboxes can take hours.</>,
      <>Download the archive and <b>unzip</b> it. Open <code>Takeout/Mail</code>: there is one <code>.mbox</code> file per Gmail label.</>,
      <>Select those <code>.mbox</code> files in the import box below. A message with several labels appears in several files; duplicates are skipped automatically.</>,
    ],
  },
  microsoft: {
    title: "Export from Outlook",
    steps: [
      <>In Outlook for Windows, go to <b>File → Open &amp; Export → Import/Export → Export to a file → Outlook Data File (.pst)</b>. Select the mail folders you want, or the whole mailbox.</>,
      <>Outlook exports PST, not mbox. Convert it with a free tool: in <b>Thunderbird</b>, install the <b>ImportExportTools NG</b> add-on, import the <code>.pst</code>, then right-click each folder → <b>ImportExportTools NG → Export folder</b> and choose <b>mbox</b>. The <code>readpst</code> command from libpst also converts PST to mbox.</>,
      <>Select the resulting <code>.mbox</code> files in the import box below.</>,
      <>Microsoft Purview eDiscovery exports also produce PST files — the same conversion applies.</>,
    ],
  },
  other: {
    title: "Export from your webmail",
    steps: [
      <>Check your provider's settings for an export or backup option — many webmail services offer mbox or EML export under Import/Export.</>,
      <>If there is no export, sync the account in <b>Thunderbird</b>, then export each folder to mbox with the ImportExportTools NG add-on.</>,
      <>Select the <code>.mbox</code> or <code>.eml</code> files in the import box below. A single <code>.eml</code> file imports one message.</>,
    ],
  },
};

export function MigrateMail() {
  const [source, setSource] = useState<Source>("google");
  const current = STEPS[source];

  return (
    <div className="page" style={{ maxWidth: 880 }}>
      <h1 style={{ marginBottom: 4 }}>Move your mail to Kreatix</h1>
      <p className="d-sub" style={{ marginTop: 0 }}>
        Bring your existing mail, with its original dates and folders, into Kreatix Mail. Import while your old
        account still works — you can run the import again later to pick up anything new, and messages that are already here are skipped.
      </p>

      <section className="admin-card">
        <h2 style={{ marginTop: 0 }}>1 · Export your mail</h2>
        <div className="audit-bar" style={{ marginBottom: 12 }}>
          {SOURCES.map((s) => (
            <button key={s.id} className={source === s.id ? "btn-primary" : "btn-secondary"}
              onClick={() => setSource(s.id)}>{s.label}</button>
          ))}
        </div>
        <h3 style={{ margin: "4px 0 8px", fontSize: 15 }}>{current.title}</h3>
        <ol style={{ paddingLeft: 20, lineHeight: 1.6, margin: 0 }}>
          {current.steps.map((s, i) => <li key={i} style={{ marginBottom: 6 }}>{s}</li>)}
        </ol>
      </section>

      <section className="admin-card">
        <h2 style={{ marginTop: 0 }}>2 · Import into Kreatix Mail</h2>
        <p className="d-sub" style={{ marginTop: 0 }}>
          Files up to 4 GB each. Large files upload in chunks and resume automatically if the connection drops.
          Imported mail lands in its own folder; mail you sent is placed in Sent.
        </p>
        <MailImportTool />
      </section>

      <section className="admin-card">
        <h2 style={{ marginTop: 0 }}>3 · Switch over</h2>
        <ol style={{ paddingLeft: 20, lineHeight: 1.6, margin: 0 }}>
          <li style={{ marginBottom: 6 }}>Import your history first, while the old account still works.</li>
          <li style={{ marginBottom: 6 }}>Shortly before switching, import the newest export again. Only messages that are new since the last import are added.</li>
          <li style={{ marginBottom: 6 }}>
            Point your domain's MX records at Kreatix once the checklist in{" "}
            <Link to="/admin#domains">Admin → Email domains</Link> is green. New mail then arrives here.
          </li>
          <li style={{ marginBottom: 6 }}>Keep the old account for a few weeks to catch stray mail, then close it.</li>
        </ol>
      </section>

      <section className="admin-card">
        <h2 style={{ marginTop: 0 }}>Files and contacts</h2>
        <ul style={{ paddingLeft: 20, lineHeight: 1.6, margin: 0 }}>
          <li style={{ marginBottom: 6 }}>
            <b>Files:</b> download them from Google Drive, OneDrive or SharePoint and upload them to <Link to="/drive">Drive</Link>.
            Google Docs, Sheets and Slides can be downloaded as Word, Excel and PowerPoint files from Google's <b>File → Download</b> menu.
          </li>
          <li style={{ marginBottom: 6 }}>
            <b>Contacts:</b> export them as CSV or vCard from your provider. Importing contacts is not available yet.
          </li>
        </ul>
      </section>
    </div>
  );
}
