// theme before first paint — default light, persisted in localStorage
// (external file: CSP script-src 'self' forbids inline scripts)
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("kx_theme") === "dark" ? "dark" : "light";
} catch { document.documentElement.dataset.theme = "light"; }
