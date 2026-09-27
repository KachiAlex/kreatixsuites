import { useRef, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { readPageSetup } from "./PageSetup";

const IN = 96; // px per inch at 96dpi
const INDENT_STEP = 24;

/** Horizontal ruler above the page — inch ticks, margin shading, and
 *  draggable left-indent markers (Docs/Word convention). */
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
  for (let x = 0; x <= width; x += IN / 8) {
    const isInch = x % IN === 0;
    const isHalf = x % (IN / 2) === 0;
    const isQuarter = x % (IN / 4) === 0;
    const h = isInch ? 10 : isHalf ? 8 : isQuarter ? 6 : 4;
    ticks.push(<line key={x} x1={x} x2={x} y1={22 - h} y2={22} stroke="#9B948E" strokeWidth={1} />);
  }
  const numbers: React.ReactElement[] = [];
  for (let x = IN; x < width - mr + 8; x += IN) {
    numbers.push(
      <text key={x} x={x} y={10} textAnchor="middle" fontSize={8} fill="#8B837D"
        fontFamily="Inter, sans-serif">{x / IN}</text>,
    );
  }

  return (
    <div className="ruler-wrap" aria-hidden="true">
      <svg ref={svgRef} className="ruler" width={width} height={24} viewBox={`0 0 ${width} 24`}
        onPointerMove={onMove} onPointerUp={() => setDrag(null)} onPointerLeave={() => setDrag(null)}>
        {/* page body + margin shading */}
        <rect x={0} y={4} width={width} height={20} fill="#fff" stroke="#E0DAD3" />
        <rect x={0} y={4} width={ml} height={20} fill="#F1ECE6" />
        <rect x={width - mr} y={4} width={mr} height={20} fill="#F1ECE6" />
        {/* ticks only inside the writeable zone, like Docs */}
        <g clipPath="url(#ruler-clip)">
          <clipPath id="ruler-clip"><rect x={ml} y={4} width={width - ml - mr} height={20} /></clipPath>
          {ticks}
          {numbers}
        </g>
        {/* margin edges */}
        <line x1={ml} x2={ml} y1={4} y2={24} stroke="#D0C8BF" />
        <line x1={width - mr} x2={width - mr} y1={4} y2={24} stroke="#D0C8BF" />
        {/* left-indent marker (draggable) */}
        <g transform={`translate(${markerX},0)`} style={{ cursor: "ew-resize" }}
          onPointerDown={startDrag}>
          <rect x={-6} y={0} width={12} height={4} rx={1} fill="#5B9BD5" />
          <polygon points="-4,4 4,4 0,10" fill="#5B9BD5" />
          <rect x={-8} y={0} width={16} height={12} fill="transparent" />
        </g>
      </svg>
    </div>
  );
}
