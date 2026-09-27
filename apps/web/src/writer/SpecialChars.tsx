import { useState } from "react";
import type { Editor } from "@tiptap/react";

const GROUPS: Record<string, string[]> = {
  Currency: ["€", "£", "¥", "¢", "₹", "₽", "₩", "₪", "$"],
  Math: ["±", "×", "÷", "≠", "≈", "≤", "≥", "∞", "∑", "∏", "√", "∫", "∂", "∆", "π", "µ", "°", "‰", "½", "¼", "¾"],
  Arrows: ["→", "←", "↑", "↓", "↔", "⇒", "⇐", "⇔", "↗", "↘", "⇄"],
  Greek: ["α", "β", "γ", "δ", "ε", "θ", "λ", "μ", "ν", "ξ", "ρ", "σ", "τ", "φ", "χ", "ψ", "ω", "Ω", "Σ", "Δ", "Φ", "Λ", "Γ"],
  Symbols: ["©", "®", "™", "§", "¶", "†", "‡", "•", "◦", "–", "—", "…", "‰", "‹", "›", "«", "»", "№", "★", "☆", "✓", "✗", "♠", "♣", "♥", "♦"],
  Quotes: ["“", "”", "‘", "’", "‚", "„", "‹", "›", "«", "»"],
};

export function SpecialChars({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [group, setGroup] = useState<keyof typeof GROUPS>("Symbols");
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Special characters">
        <h3>Special characters</h3>
        <div className="sc-tabs">
          {(Object.keys(GROUPS) as (keyof typeof GROUPS)[]).map((g) => (
            <button key={g} className={`sc-tab ${group === g ? "on" : ""}`} onClick={() => setGroup(g)}>{g}</button>
          ))}
        </div>
        <div className="sc-grid">
          {GROUPS[group].map((ch) => (
            <button key={ch} className="sc-char" onClick={() => { editor.chain().focus().insertContent(ch).run(); onClose(); }}>
              {ch}
            </button>
          ))}
        </div>
        <button className="btn-ghost btn-sm" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
