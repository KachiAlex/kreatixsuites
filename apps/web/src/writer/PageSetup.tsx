import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { PAGE_SIZES, type PageSize } from "tiptap-pagination-plus";

export interface PageSetup {
  sizeName: string;
  width: number;
  height: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  headerLeft: string;
  headerRight: string;
  footerLeft: string;
  footerRight: string;
}

export const DEFAULT_SETUP: PageSetup = {
  sizeName: "LETTER",
  ...PAGE_SIZES.LETTER && {
    width: PAGE_SIZES.LETTER.pageWidth, height: PAGE_SIZES.LETTER.pageHeight,
    marginTop: PAGE_SIZES.LETTER.marginTop, marginBottom: PAGE_SIZES.LETTER.marginBottom,
    marginLeft: PAGE_SIZES.LETTER.marginLeft, marginRight: PAGE_SIZES.LETTER.marginRight,
  },
  headerLeft: "", headerRight: "", footerLeft: "", footerRight: "Page {page} of {total}",
};

/** Read current pagination config from extension storage. */
export function readPageSetup(editor: Editor): PageSetup {
  const s = editor.storage.PaginationPlus;
  const sizeName = (Object.keys(PAGE_SIZES) as (keyof typeof PAGE_SIZES)[]).find(
    (k) => PAGE_SIZES[k].pageWidth === s.pageWidth && PAGE_SIZES[k].pageHeight === s.pageHeight,
  ) ?? "CUSTOM";
  return {
    sizeName,
    width: s.pageWidth, height: s.pageHeight,
    marginTop: s.marginTop, marginBottom: s.marginBottom,
    marginLeft: s.marginLeft, marginRight: s.marginRight,
    headerLeft: s.headerLeft ?? "", headerRight: s.headerRight ?? "",
    footerLeft: s.footerLeft ?? "", footerRight: s.footerRight ?? "",
  };
}

/** Apply a PageSetup to the live editor. */
export function applyPageSetup(editor: Editor, setup: PageSetup) {
  const size: PageSize = {
    pageWidth: setup.width, pageHeight: setup.height,
    marginTop: setup.marginTop, marginBottom: setup.marginBottom,
    marginLeft: setup.marginLeft, marginRight: setup.marginRight,
  };
  editor.chain()
    .updatePageSize(size)
    .updateMargins({ top: setup.marginTop, bottom: setup.marginBottom, left: setup.marginLeft, right: setup.marginRight })
    .updateHeaderContent(setup.headerLeft, setup.headerRight)
    .updateFooterContent(setup.footerLeft, setup.footerRight)
    .run();
}

export function PageSetupDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [s, setS] = useState<PageSetup>(() => readPageSetup(editor));
  const set = (k: keyof PageSetup, v: string | number) => setS((p) => ({ ...p, [k]: v }));

  const pickSize = (name: string) => {
    const p = PAGE_SIZES[name as keyof typeof PAGE_SIZES];
    if (!p) return;
    setS((prev) => ({
      ...prev, sizeName: name, width: p.pageWidth, height: p.pageHeight,
      marginTop: p.marginTop, marginBottom: p.marginBottom,
      marginLeft: p.marginLeft, marginRight: p.marginRight,
    }));
  };

  const rotate = () => setS((p) => ({ ...p, sizeName: "CUSTOM", width: p.height, height: p.width }));

  const num = (k: keyof PageSetup, label: string) => (
    <label className="ps-field">
      <span>{label}</span>
      <input type="number" min={0} value={s[k] as number}
        onChange={(e) => set(k, Math.max(0, parseInt(e.target.value) || 0))} />
    </label>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card ps-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Page setup">
        <h3>Page setup</h3>
        <div className="ps-row">
          <label className="ps-field"><span>Paper size</span>
            <select value={s.sizeName} onChange={(e) => pickSize(e.target.value)}>
              {Object.keys(PAGE_SIZES).map((k) => <option key={k} value={k}>{k}</option>)}
              <option value="CUSTOM">Custom</option>
            </select>
          </label>
          <button className="btn-ghost btn-sm" onClick={rotate} title="Swap width/height">Orientation: portrait ⇄ landscape</button>
        </div>
        <div className="ps-row">
          {num("width", "Width px")}{num("height", "Height px")}
        </div>
        <div className="ps-row">
          {num("marginTop", "Margin top")}{num("marginBottom", "Margin bottom")}
        </div>
        <div className="ps-row">
          {num("marginLeft", "Margin left")}{num("marginRight", "Margin right")}
        </div>
        <div className="ps-row">
          <label className="ps-field grow"><span>Header left ({"{page}"} / {"{total}"} tokens)</span>
            <input value={s.headerLeft} onChange={(e) => set("headerLeft", e.target.value)} /></label>
          <label className="ps-field grow"><span>Header right</span>
            <input value={s.headerRight} onChange={(e) => set("headerRight", e.target.value)} /></label>
        </div>
        <div className="ps-row">
          <label className="ps-field grow"><span>Footer left</span>
            <input value={s.footerLeft} onChange={(e) => set("footerLeft", e.target.value)} /></label>
          <label className="ps-field grow"><span>Footer right</span>
            <input value={s.footerRight} onChange={(e) => set("footerRight", e.target.value)} /></label>
        </div>
        <div className="ps-actions">
          <button className="btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn-primary btn-sm" onClick={() => { applyPageSetup(editor, s); onClose(); }}>Apply</button>
        </div>
      </div>
    </div>
  );
}
