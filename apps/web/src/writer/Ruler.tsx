import { useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { readPageSetup } from "./PageSetup";

const IN = 96; // px per inch at 96dpi
const INDENT_STEP = 24;
const H = 26; // svg height

/** Horizontal ruler above the page — inch ticks, margin shading, and a
 *  draggable left-indent marker (Docs/Word convention). */
export function Ruler({ editor }: { editor: Editor }) {
  const s = readPageSetup(editor);
  const { width, marginLeft: ml, marginRight: mr } = s;

  const indent = useEditorState({
    editor,
    selector: (ctx) =>
      (ctx.editor?.getAttributes("paragraph").indent as number | undefined)
      ?? (ctx.editor?.getAttributes("heading").indent as number | undefined)
      ?? 0,
  });

  const [drag, setDrag] = useState<{ x0: number; base: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const markerX = ml + indent * INDENT_STEP;

  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({ x0: e.clientX, base: indent });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag || !svgRef.current) return;
    const scale = svgRef.current.getBoundingClientRect().width / width;
    const steps = Math.round(((e.clientX - drag.x0) / scale) / INDENT_STEP);
    const next = Math.max(0, Math.min(8, drag.base + steps));
    if (next !== indent) {
      editor.chain().focus().command(({ tr, state, dispatch }) => {
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
          if (node.type.name === "paragraph" || node.type.name === "heading") {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next });
          }
          return true;
        });
        if (dispatch) dispatch(tr);
        return true;
      }).run();
    }
  };

  const ticks: React.ReactElement[] = [];
  for (let x = 0; x <= width - ml - mr; x += IN / 8) {
    const isInch = x % IN === 0;
    const isHalf = x % (IN / 2) === 0;
    const isQuarter = x % (IN / 4) === 0;
    const h = isInch ? 9 : isHalf ? 7 : isQuarter ? 5 : 3.5;
    ticks.push(<line key={x} x1={ml + x} x2={ml + x} y1={H - 3 - h} y2={H - 3} stroke="#A39A92" strokeWidth={1} />);
  }
  const numbers: React.ReactElement[] = [];
  for (let i = 1; ml + i * IN < width - mr + IN / 2; i++) {
    numbers.push(
      <text key={i} x={ml + i * IN} y={11} textAnchor="middle" fontSize={9} fill="#7A7169"
        fontFamily="Inter, sans-serif">{i}</text>,
    );
  }

  return (
    <div className="ruler-wrap" aria-hidden="true">
      <svg ref={svgRef} className="ruler" width={width} height={H} viewBox={`0 0 ${width} ${H}`}
        onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
        {/* writable zone card */}
        <rect x={ml} y={4} width={width - ml - mr} height={H - 6} rx={2} fill="#fff" stroke="#E4DDD5" />
        {/* margin zones */}
        <rect x={0} y={4} width={ml} height={H - 6} fill="#E9E2DA" />
        <rect x={width - mr} y={4} width={mr} height={H - 6} fill="#E9E2DA" />
        {ticks}
        {numbers}
        {/* margin edges */}
        <line x1={ml} x2={ml} y1={4} y2={H - 2} stroke="#CFC7BD" />
        <line x1={width - mr} x2={width - mr} y1={4} y2={H - 2} stroke="#CFC7BD" />
        {/* left-indent marker (draggable) */}
        <g transform={`translate(${markerX},0)`} style={{ cursor: "ew-resize" }}
          onPointerDown={startDrag}>
          <rect x={-5.5} y={0} width={11} height={4.5} rx={1.2} fill="#5B8FD9" />
          <polygon points="-4.5,4.5 4.5,4.5 0,10.5" fill="#5B8FD9" />
          <rect x={-9} y={0} width={18} height={14} fill="transparent" />
        </g>
      </svg>
    </div>
  );
}
