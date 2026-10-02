// Kreatix Business Suite — shared domain types (SRS §4, §11, §19)

export type UserRole = "owner" | "admin" | "member" | "guest";
export type Permission = "owner" | "editor" | "reviewer" | "commenter" | "viewer";
export type FileKind = "folder" | "writer" | "sheets" | "present" | "pdf" | "file";

export interface User {
  id: string;
  email: string;
  displayName: string;
  initials: string;
  orgId: string;
  role: UserRole;
  isSuper?: boolean;
  /** TOTP second factor enrolled */
  mfaEnabled?: boolean;
  createdAt: string;
}

export interface Org {
  id: string;
  name: string;
  createdAt: string;
}

export interface DriveItem {
  id: string;
  orgId: string;
  parentId: string | null;
  ownerId: string;
  name: string;
  kind: FileKind;
  mimeType: string;
  size: number;
  starred: boolean;
  trashed: boolean;
  createdAt: string;
  updatedAt: string;
  /** Sensitivity label: internal | public | confidential | restricted */
  label?: string;
  /** Effective permission of the requesting user on this item */
  permission?: Permission;
  /** Number of collaborators with direct access (for UI avatars) */
  collaborators?: { initials: string; displayName: string }[];
}

export interface FileVersion {
  id: string;
  fileId: string;
  number: number;
  label: string | null;
  size: number;
  createdBy: string;
  createdAt: string;
}

export interface ShareLink {
  id: string;
  fileId: string;
  token: string;
  permission: "viewer" | "commenter" | "editor";
  expiresAt: string | null;
  hasPassword: boolean;
  blockDownload: boolean;
  createdAt: string;
}

export interface FileShare {
  id: string;
  fileId: string;
  userId: string;
  permission: Permission;
  user?: { displayName: string; email: string; initials: string };
}

export interface Comment {
  id: string;
  fileId: string;
  authorId: string;
  author?: { displayName: string; initials: string };
  /** Application-specific anchor (e.g. TipTap mark id, cell ref, slide id, pdf page) */
  anchor: string | null;
  body: string;
  resolved: boolean;
  parentId: string | null;
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  orgId: string;
  actorId: string;
  fileId: string | null;
  action: string;
  detail: string | null;
  createdAt: string;
}

// --- API payloads ---

export interface AuthTokens {
  token: string;
  user: User;
}

export interface ApiError {
  error: string;
  message: string;
}

export const FILE_KINDS: FileKind[] = ["writer", "sheets", "present", "pdf", "file"];

export const KIND_LABELS: Record<FileKind, string> = {
  folder: "Folder",
  writer: "Kreatix Writer",
  sheets: "Kreatix Sheets",
  present: "Kreatix Present",
  pdf: "Kreatix PDF",
  file: "File",
};

export const KIND_COLORS: Record<Exclude<FileKind, "folder">, string> = {
  writer: "#3578E5",
  sheets: "#1F9D66",
  present: "#E96A2C",
  pdf: "#D84B57",
  file: "#727272",
};
