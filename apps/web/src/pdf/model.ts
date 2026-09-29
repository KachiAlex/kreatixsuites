// Kreatix PDF — annotation doc model (stored as file content JSON; the PDF bytes
// themselves stay immutable in the original upload version)

export type AnnType =
  | "highlight" | "underline" | "strikeout" | "squiggly"
  | "freehand" | "polyline"
  | "rect" | "ellipse" | "line" | "arrow" | "callout" | "cloud"
  | "note" | "textbox" | "stamp"
  | "sign";

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

export interface PdfDoc {
  kind: "pdf";
  annotations: PdfAnn[];
  /** AcroForm field values harvested from pdf.js AnnotationStorage */
  form?: Record<string, unknown>;
}

export const emptyPdfDoc = (): PdfDoc => ({ kind: "pdf", annotations: [] });

export const STAMPS = ["APPROVED", "DRAFT", "CONFIDENTIAL", "FINAL", "REVIEWED"];
