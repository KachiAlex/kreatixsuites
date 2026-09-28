import { useState } from "react";

/** Word File ▸ Info ▸ Properties — persisted in the doc payload. */
export interface DocProps {
  title?: string;
  subject?: string;
  author?: string;
  keywords?: string;
  category?: string;
  comments?: string;
  /** Marked as final — opens read-only until "Edit anyway". */
  final?: boolean;
}

export const EMPTY_PROPS: DocProps = {};

export function DocPropsDialog({ initial, stats, onApply, onClose }: {
  initial: DocProps;
  stats: { words: number; paras: number; chars: number };
  onApply: (p: DocProps) => void;
  onClose: () => void;
}) {
  const [p, setP] = useState<DocProps>(initial);
  const set = (k: keyof DocProps, v: string) => setP((prev) => ({ ...prev, [k]: v }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ps-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Document properties">
        <h3>Properties</h3>
        <div className="ps-row">
          <label className="ps-field grow"><span>Title</span>
            <input value={p.title ?? ""} onChange={(e) => set("title", e.target.value)} /></label>
          <label className="ps-field grow"><span>Subject</span>
            <input value={p.subject ?? ""} onChange={(e) => set("subject", e.target.value)} /></label>
        </div>
        <div className="ps-row">
          <label className="ps-field grow"><span>Author</span>
            <input value={p.author ?? ""} onChange={(e) => set("author", e.target.value)} /></label>
          <label className="ps-field grow"><span>Category</span>
            <input value={p.category ?? ""} onChange={(e) => set("category", e.target.value)} /></label>
        </div>
        <div className="ps-row">
          <label className="ps-field grow"><span>Keywords</span>
            <input value={p.keywords ?? ""} placeholder="comma, separated" onChange={(e) => set("keywords", e.target.value)} /></label>
        </div>
        <div className="ps-row">
          <label className="ps-field grow"><span>Comments</span>
            <input value={p.comments ?? ""} onChange={(e) => set("comments", e.target.value)} /></label>
        </div>
        <h4 className="ps-section">Statistics</h4>
        <div className="ps-row" style={{ fontSize: 12, color: "#6B625C" }}>
          <span>{stats.words} words</span><span>·</span>
          <span>{stats.paras} paragraphs</span><span>·</span>
          <span>{stats.chars} characters</span>
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => { onApply(p); onClose(); }}>Apply</button>
        </div>
      </div>
    </div>
  );
}

/** Signature-line insert dialog. */
export function SignatureDialog({ onInsert, onClose }: {
  onInsert: (a: { signer: string; title: string; showDate: boolean }) => void;
  onClose: () => void;
}) {
  const [signer, setSigner] = useState("");
  const [title, setTitle] = useState("");
  const [showDate, setShowDate] = useState(true);
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ps-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Signature line">
        <h3>Signature line</h3>
        <div className="ps-row">
          <label className="ps-field grow"><span>Suggested signer</span>
            <input autoFocus value={signer} onChange={(e) => setSigner(e.target.value)} /></label>
        </div>
        <div className="ps-row">
          <label className="ps-field grow"><span>Suggested signer's title</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        </div>
        <div className="ps-row">
          <label className="ps-check">
            <input type="checkbox" checked={showDate} onChange={(e) => setShowDate(e.target.checked)} />
            <span>Show sign date in the signature line</span>
          </label>
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => { onInsert({ signer, title, showDate }); onClose(); }}>Insert</button>
        </div>
      </div>
    </div>
  );
}
