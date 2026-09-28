import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!, {
  onRecoverableError: (error) => {
    // TipTap's editor-view proxy throws while plugins run during EditorView
    // construction; React recovers by sync-rendering. Harmless upstream
    // artifact — report everything else normally.
    const msg = String((error as Error)?.message ?? error);
    if (msg.includes("[tiptap error]: The editor view is not available")) return;
    console.error(error);
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
