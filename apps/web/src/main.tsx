import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
// self-hosted Inter (latin subsets) — no Google Fonts CDN round-trip
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-800.css";
import { registerSW } from "virtual:pwa-register";

// PWA — precached app shell + offline navigation (API calls stay live)
if (import.meta.env.PROD) registerSW({ immediate: true });

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
