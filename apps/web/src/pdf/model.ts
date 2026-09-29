// Kreatix PDF — annotation doc model (stored as file content JSON; the PDF bytes
// themselves stay immutable in the original upload version)

export type AnnType =
  | "highlight" | "underline" | "strikeout" | "squiggly"
  | "freehand" | "polyline"
  | "rect" | "ellipse" | "line" | "arrow" | "callout" | "cloud"
  | "note" | "textbox" | "stamp"
  | "sign" | "image" | "whiteout"
  | "redact"; // PDF-7 — page content under the mark is physically removed on export

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
  // PDF-5 — review metadata
  author?: string;
  status?: "accepted" | "rejected" | "completed" | "none";
  replies?: { by: string; text: string; at: string }[];
  createdAt?: string;
}

// PDF-6 — form fields authored on top of the page (become real AcroForm
// fields on export via pdf-lib)
export type FieldKind = "text" | "checkbox" | "radio" | "dropdown" | "list";
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
}

export interface PdfDoc {
  kind: "pdf";
  annotations: PdfAnn[];
  /** AcroForm field values harvested from pdf.js AnnotationStorage */
  form?: Record<string, unknown>;
  fields?: PdfField[];
}

export const emptyPdfDoc = (): PdfDoc => ({ kind: "pdf", annotations: [], fields: [] });

export const STAMPS = ["APPROVED", "DRAFT", "CONFIDENTIAL", "FINAL", "REVIEWED"];
