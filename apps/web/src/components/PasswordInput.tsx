// Password field with a show/hide eye toggle. Drop-in for <input type="password"> —
// forwards every prop; only `type` is managed. The toggle is tabIndex -1 so it
// never interrupts form tab order.
import { useState, type CSSProperties, type InputHTMLAttributes } from "react";

const Eye = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const EyeOff = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2 12s3.5-7 10-7c2.2 0 4.1.8 5.7 1.9M22 12s-3.5 7-10 7c-2.2 0-4.1-.8-5.7-1.9" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </svg>
);

export function PasswordInput({ style, wrapperStyle, ...rest }: InputHTMLAttributes<HTMLInputElement> & { wrapperStyle?: CSSProperties }) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw-wrap" style={wrapperStyle}>
      <input {...rest} type={show ? "text" : "password"} style={style} />
      <button type="button" className="pw-toggle" tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        title={show ? "Hide password" : "Show password"}>
        {show ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}
