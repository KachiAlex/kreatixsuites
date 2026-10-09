// Print a standalone HTML document through an invisible iframe. window.open
// needs a live user-gesture — export code that awaits a lazy chunk first loses
// it, so popup blockers silently kill the print window (the "PDF export does
// nothing" bug). An iframe's document needs no gesture: its own auto-print
// script fires on load, and the frame is reaped after printing or a timeout.
export function printHtmlFrame(html: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none";
  document.body.appendChild(iframe);
  const cleanup = () => iframe.remove();
  iframe.onload = () => iframe.contentWindow?.addEventListener("afterprint", cleanup);
  // the doc's own onload script calls print(); if an engine never fires it
  // (or skips afterprint), still reap the frame rather than leak it
  setTimeout(cleanup, 120_000);
  iframe.srcdoc = html;
}
