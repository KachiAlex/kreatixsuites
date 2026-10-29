// Print a standalone HTML document through an invisible iframe. window.open
// needs a live user-gesture — export code that awaits a lazy chunk first loses
// it, so popup blockers silently kill the print window (the "PDF export does
// nothing" bug). An iframe's document needs no gesture: its own auto-print
// script fires on load, and the frame is reaped after printing or a timeout.
/** The app's stylesheets, including the live page-number counter rules, as markup
 *  for a standalone print document (it doesn't inherit the app's styles). */
export const appStyleTags = (): string =>
  [...document.querySelectorAll('link[rel="stylesheet"], style')].map((el) => el.outerHTML).join("");

export function printHtmlFrame(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);
  const cleanup = () => iframe.remove();
  // print from the app, not from an inline script in the frame: the app's CSP
  // blocks inline scripts, so a script inside the document never runs and the
  // dialog silently never opens
  iframe.onload = () => {
    const w = iframe.contentWindow;
    if (!w) return cleanup();
    w.addEventListener("afterprint", cleanup);
    setTimeout(() => { w.focus(); w.print(); }, 300);
  };
  // if an engine never fires afterprint, still reap the frame rather than leak it
  setTimeout(cleanup, 120_000);
  iframe.srcdoc = html;
}
