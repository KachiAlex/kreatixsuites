import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import {
  bandPadBottom, bandPadTop, keepNextPadTop, measureBands, splitPadTop, vAlignPadTop,
} from "../banding";

const PADS_META = "kx-pads";
const pluginKey = new PluginKey<DecorationSet>("kx-forced-breaks");

interface PadOp { pos: number; end: number; style: string }

/**
 * Honors explicit break semantics inside the PaginationPlus layout by adding
 * padding to break elements until they reach page-band boundaries
 * (see ../banding.ts for the measurement math).
 *
 * Pads are stored as *node decorations* — plugin state, not inline DOM writes —
 * because ProseMirror re-renders nodes on unrelated transactions, which would
 * wipe style attributes. Decorations are re-merged into the rendered node on
 * every draw, so a pad, once measured, survives DOM churn.
 *
 * The measure loop runs on rAF after every view update and after structural
 * DOM mutations (paginator wall rebuilds). Pads change scrollHeight → the
 * paginator recounts pages on its own — the two converge because a break that
 * lands mid-wall stops influencing the wall set.
 */
export const ForcedBreaks = Extension.create({
  name: "forcedBreaks",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: pluginKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const pads = tr.getMeta(PADS_META) as PadOp[] | undefined;
            if (pads) {
              return DecorationSet.create(
                tr.doc,
                pads
                  .filter((p) => p.pos < tr.doc.content.size)
                  .map((p) => Decoration.node(p.pos, p.end, { style: p.style })),
              );
            }
            return tr.docChanged ? set.map(tr.mapping, tr.doc) : set;
          },
        },
        props: {
          decorations(state) {
            return pluginKey.getState(state);
          },
        },
        view(editorView) {
          let raf = 0;
          let observer: MutationObserver | null = null;
          let lastSig = "";
          let churn = 0;
          // per-position oscillation bookkeeping (positions are stable while
          // the doc is unchanged; cleared on every doc edit)
          const hist = new Map<number, string[]>();
          const frozen = new Map<number, string>();

          const posOfEl = (el: HTMLElement): { pos: number; end: number } | null => {
            try {
              for (const bias of [-1, 1]) {
                const pos = editorView.posAtDOM(el, 0, bias as never);
                for (const cand of [pos, pos - 1]) {
                  if (cand < 0 || cand >= editorView.state.doc.content.size) continue;
                  if (editorView.nodeDOM(cand) === el) {
                    const n = editorView.state.doc.nodeAt(cand);
                    if (n) return { pos: cand, end: cand + n.nodeSize };
                  }
                }
              }
            } catch { /* mid-render */ }
            return null;
          };

          const measure = () => {
            const root = editorView.dom;
            if (!root.isConnected || !root.classList.contains("rm-with-pagination")
              || root.hasAttribute("rm-pagination-disabled")) return;

            // desired pads per element — pos → { top, bottom, end }
            const want = new Map<number, { top: number; bottom: number; end: number }>();
            const add = (el: HTMLElement, top: number | null, bottom: number | null) => {
              if (top == null && bottom == null) return;
              const loc = posOfEl(el);
              if (!loc) return;
              const cur = want.get(loc.pos) ?? { top: 0, bottom: 0, end: loc.end };
              cur.top = Math.max(cur.top, top ?? 0);
              cur.bottom = Math.max(cur.bottom, bottom ?? 0);
              want.set(loc.pos, cur);
            };

            // measure the band layout ONCE per pass — each helper used to
            // re-query every .breaker rect, so N decorated blocks × W walls
            // forced N×W synchronous reflows on every keystroke
            const bands = measureBands(root);

            for (const el of root.querySelectorAll<HTMLElement>("[data-pb-before]")) {
              add(el, bandPadTop(el, root, bands), null);
            }
            for (const el of root.querySelectorAll<HTMLElement>("[data-force-break]")) {
              const oe = el.getAttribute("data-odd-even");
              add(el, null, bandPadBottom(
                el, root, 0,
                oe === "oddPage" ? { skipTo: "odd" } : oe === "evenPage" ? { skipTo: "even" } : undefined,
                bands,
              ));
            }
            for (const el of root.querySelectorAll<HTMLElement>("[data-keep-next]")) {
              add(el, keepNextPadTop(el, root, bands), null);
            }
            for (const el of root.querySelectorAll<HTMLElement>("[data-keep-lines],[data-widow-orphan]")) {
              add(el, splitPadTop(el, root, el.hasAttribute("data-keep-lines"), bands), null);
            }
            // section vertical alignment: the break div introduces the
            // section → pad its first content block; a vAlign'd block is
            // itself the first block (document's first section)
            for (const el of root.querySelectorAll<HTMLElement>("[data-v-align]")) {
              const mode = el.getAttribute("data-v-align") ?? "";
              let target: HTMLElement | null =
                el.hasAttribute("data-force-break") || el.classList.contains("section-break")
                  ? el.nextElementSibling as HTMLElement | null
                  : el;
              while (target && !posOfEl(target))
                target = target.nextElementSibling as HTMLElement | null;
              if (target) add(target, vAlignPadTop(target, root, mode, bands), null);
            }

            const ops: PadOp[] = [];
            const sigParts: string[] = [];
            for (const [pos, v] of [...want.entries()].sort((a, b) => a[0] - b[0])) {
              let style = "";
              const h = hist.get(pos) ?? [];
              const cur = `${Math.round(v.top)},${Math.round(v.bottom)}`;
              if (frozen.has(pos)) {
                style = frozen.get(pos)!;
              } else {
                // period-2 oscillation → freeze at the larger pad (over-padding
                // is the safe side: deeper into the wall region)
                h.push(cur);
                if (h.length > 6) h.shift();
                hist.set(pos, h);
                if (h.length >= 4) {
                  const [a, b, c, d] = h.slice(-4);
                  if (a === c && b === d && a !== b) {
                    const pads = h.slice(-4).map((s) => s.split(",").map(Number));
                    const mt = Math.max(...pads.map((p) => p[0]));
                    const mb = Math.max(...pads.map((p) => p[1]));
                    style = `padding-top:${mt}px;padding-bottom:${mb}px`;
                    frozen.set(pos, style);
                  }
                }
                if (!style) {
                  style = `padding-top:${v.top}px;padding-bottom:${v.bottom}px`;
                }
              }
              sigParts.push(`${pos}=${style}`);
              if (v.top > 0 || v.bottom > 0 || frozen.has(pos)) {
                ops.push({ pos, end: v.end, style });
              }
            }
            const sig = sigParts.join("|");
            if (sig === lastSig) { churn = 0; return; }
            // dispatching a pads tx triggers update()→schedule()→measure — a
            // longer-than-period-2 oscillation would churn forever; cap it and
            // wait for the next real doc/layout change
            if (churn > 60) return;
            churn++;
            lastSig = sig;
            editorView.dispatch(editorView.state.tr.setMeta(PADS_META, ops));
          };

          const schedule = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(measure);
          };

          // PM re-renders replace content nodes — every structural change may
          // have shifted bands, so re-measure. Our pads are state-side
          // decorations, so measure→dispatch→render can't self-trigger:
          // a repeated pad signature short-circuits before dispatch.
          observer = new MutationObserver((muts) => {
            if (muts.some((m) => m.type === "childList"
              && (m.addedNodes.length || m.removedNodes.length))) schedule();
          });
          observer.observe(editorView.dom, { childList: true, subtree: true });
          schedule();

          return {
            update(view, prevState) {
              if (view.state.doc !== prevState.doc) {
                hist.clear();
                frozen.clear();
                lastSig = "";
                churn = 0;
              }
              schedule();
            },
            destroy() {
              cancelAnimationFrame(raf);
              observer?.disconnect();
            },
          };
        },
      }),
    ];
  },
});
