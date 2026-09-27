import { useEffect, useRef } from "react";

export interface MiniPromptSpec {
  title: string;
  label?: string;
  placeholder?: string;
  initial?: string;
}

/** Small modal input — replaces window.prompt() for link/image/footnote flows. */
export function MiniPrompt({ spec, onDone }: {
  spec: MiniPromptSpec;
  onDone: (value: string | null) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { ref.current?.focus(); ref.current?.select(); }, []);
  const done = (v: string | null) => onDone(v);
  return (
    <div className="modal-overlay" onClick={() => done(null)}>
      <div className="modal-card mini-prompt" role="dialog" aria-label={spec.title}
        onClick={(e) => e.stopPropagation()}>
        <h3>{spec.title}</h3>
        {spec.label && <p className="mini-prompt-label">{spec.label}</p>}
        <input
          ref={ref}
          defaultValue={spec.initial ?? ""}
          placeholder={spec.placeholder}
          aria-label={spec.label ?? spec.title}
          onKeyDown={(e) => {
            if (e.key === "Enter") done(ref.current?.value ?? null);
            else if (e.key === "Escape") done(null);
          }}
        />
        <div className="mini-prompt-actions">
          <button className="btn-ghost btn-sm" onClick={() => done(null)}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => done(ref.current?.value ?? "")}>OK</button>
        </div>
      </div>
    </div>
  );
}
