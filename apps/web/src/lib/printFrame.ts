// Print a standalone HTML document through an invisible iframe. window.open
// needs a live user-gesture — export code that awaits a lazy chunk first loses
// it, so popup blockers silently kill the print window (the "PDF export does
// nothing" bug). An iframe's document needs no gesture: its own auto-print
// script fires on load, and the frame is reaped after printing or a timeout.
/** Font faces and live page-number counter rules for a standalone print document.
 *  Only these are copied: the app's own print rules hide the document body. */
export const appStyleTags = (): string => {
  const fonts: string[] = [];
  // pagination counters (page-break increments, footer page numbers) are plain
  // style rules keyed on these classes; media rules are skipped so the app's
  // print rules that hide the body never reach the frame
  const PAGINATION = /counter|page-number|rm-page|rm-with-pagination|rm-first-page/;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === CSSRule.FONT_FACE_RULE) fonts.push(rule.cssText);
        else if (rule.type === CSSRule.STYLE_RULE && PAGINATION.test(rule.cssText)) fonts.push(rule.cssText);
      }
    } catch { /* cross-origin sheet — no rules to read */ }
  }
  const counters = document.getElementById("kx-page-number-style")?.textContent ?? "";
  return `<style>${fonts.join("\n")}\n${counters}</style>`;
};

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
