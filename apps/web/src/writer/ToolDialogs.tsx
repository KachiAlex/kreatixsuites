import type { Editor } from "@tiptap/react";
import { readability, a11yCheck, type A11yIssue } from "./proofing";

const easeLabel = (f: number) =>
  f >= 80 ? "Easy" : f >= 60 ? "Standard" : f >= 40 ? "Fairly difficult" : f >= 20 ? "Difficult" : "Very difficult";

/** Word ▸ Readability statistics (shown after spellcheck in Word). */
export function ReadabilityDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const r = readability(editor.state.doc.textContent);
  const rows: [string, string][] = [
    ["Words", String(r.words)],
    ["Sentences", String(r.sentences)],
    ["Syllables", String(r.syllables)],
    ["Avg. words / sentence", String(r.avgSentenceLen)],
    ["Avg. syllables / word", String(r.avgSyllablesPerWord)],
    ["Long words (3+ syllables)", String(r.longWords)],
  ];
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Readability">
        <h3>Readability statistics</h3>
        <div className="tp-body">
          <div className="read-hero">
            <div className="read-score">{r.fleschEase}</div>
            <div>
              <div className="read-name">Flesch Reading Ease</div>
              <div className="read-sub">{easeLabel(r.fleschEase)} — higher is easier (60–70 is standard)</div>
            </div>
          </div>
          <div className="read-hero">
            <div className="read-score">{r.fkGrade}</div>
            <div>
              <div className="read-name">Flesch–Kincaid Grade Level</div>
              <div className="read-sub">US school grade needed to read this</div>
            </div>
          </div>
          <table className="read-table">
            <tbody>{rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{v}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="tp-actions"><button className="btn-primary btn-sm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

const A11Y_LABELS: Record<string, string> = {
  "image-alt": "Images",
  "empty-heading": "Headings",
  "heading-skip": "Headings",
  "link-text": "Links",
};

/** Word ▸ Check Accessibility — scans for common issues. */
export function AccessibilityDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const issues = a11yCheck(editor.state.doc as Parameters<typeof a11yCheck>[0]);
  const byKind = issues.reduce<Record<string, A11yIssue[]>>((m, i) => {
    (m[A11Y_LABELS[i.kind] ?? i.kind] ??= []).push(i);
    return m;
  }, {});
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card tp-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Accessibility">
        <h3>Accessibility checker</h3>
        <div className="tp-body">
          {!issues.length && <div className="outline-empty" style={{ padding: "18px 0" }}>No accessibility issues found. People with disabilities should be able to read this document.</div>}
          {Object.entries(byKind).map(([group, list]) => (
            <div key={group} style={{ marginBottom: 10 }}>
              <div className="outline-head" style={{ padding: "0 0 4px" }}>{group}</div>
              {list.map((i, n) => <div key={n} className="a11y-issue">⚠ {i.detail}</div>)}
            </div>
          ))}
        </div>
        <div className="tp-actions"><button className="btn-primary btn-sm" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}
