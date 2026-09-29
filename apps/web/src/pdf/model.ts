// Kreatix PDF — annotation doc model (stored as file content JSON; the PDF bytes
// themselves stay immutable in the original upload version)

export type AnnType =
  | "highlight" | "underline" | "strikeout" | "squiggly"
  | "freehand" | "polyline"
  | "rect" | "ellipse" | "line" | "arrow" | "callout" | "cloud"
  | "note" | "textbox" | "stamp"
  | "sign" | "image" | "whiteout"
  | "redact" // PDF-7 — page content under the mark is physically removed on export
  | "caret" | "replace"; // PDF-12.1 — proofing marks (insert-at-caret / replace-text)

export interface PdfAnn {
  id: string;
  type: AnnType;
  page: number; // 1-based
  color?: string;
  /** [x,y,w,h] in PDF user-space units (origin bottom-left, unrotated) */
  rects?: [number, number, number, number][];
  /** polyline / line endpoints in PDF user-space */
  points?: [number, number][];
  text?: string;
  img?: string; // PDF-2 — signature image (PNG data URL)
  font?: "helv" | "times" | "courier"; // PDF-8.4 — textbox font family
  fontSize?: number;                   // PDF-8.4 — textbox size (pt)
  // PDF-5 — review metadata
  author?: string;
  status?: "accepted" | "rejected" | "completed" | "none";
  replies?: { by: string; text: string; at: string }[];
  createdAt?: string;
}

// PDF-6 — form fields authored on top of the page (become real AcroForm
// fields on export via pdf-lib)
export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "list" | "signature" | "barcode";
export interface PdfField {
  id: string;
  page: number; // 1-based
  kind: FieldKind;
  name: string;
  rect: [number, number, number, number]; // pdf user-space
  options?: string[];   // dropdown / list
  group?: string;       // radio group name (defaults to name)
  required?: boolean;
  value?: string | boolean;
  /** "sum:a,b,c" — recompute as the sum of the named sibling fields */
  calc?: string;
  /** regex pattern the text value must match (HTML pattern validation) */
  pattern?: string;
  /** prefill when no value is set */
  defaultValue?: string;
  /** comb field — max chars, rendered as evenly-spaced boxes */
  comb?: number;
}

// PDF-8.3 — OCR overlay: recognized words (pdf user-space) make scanned
// pages selectable/copyable in the viewer and searchable on export
export interface OcrWord { x: number; y: number; w: number; h: number; text: string; }

export interface PdfDoc {
  kind: "pdf";
  annotations: PdfAnn[];
  /** AcroForm field values harvested from pdf.js AnnotationStorage */
  form?: Record<string, unknown>;
  fields?: PdfField[];
  /** PDF-8.3 — OCR word boxes keyed by 1-based page number */
  ocr?: Record<string, OcrWord[]>;
}

export const emptyPdfDoc = (): PdfDoc => ({ kind: "pdf", annotations: [], fields: [] });

export const STAMPS = ["APPROVED", "DRAFT", "CONFIDENTIAL", "FINAL", "REVIEWED"];
