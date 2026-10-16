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
  /** Site library this item lives in (null = personal/root Drive) */
  libraryId?: string | null;
  /** Content type schema for this item (SharePoint reusable schema) */
  contentTypeId?: string | null;
  /** Check-out lock — set while someone holds the exclusive editing lock */
  checkedOut?: { userId: string; name: string; at: string } | null;
  /** Custom-column values for library listings: columnId → value */
  metadata?: Record<string, string | null>;
  /** Permission was granted by a share on an ancestor folder */
  inherited?: boolean;
  /** Head draft is submitted for approval (content-approval libraries) */
  pendingApproval?: boolean;
  /** Requesting user may approve/reject submissions (site-owner in libraries) */
  canApprove?: boolean;
  /** Effective permission of the requesting user on this item */
  permission?: Permission;
  /** Number of collaborators with direct access (for UI avatars) */
  collaborators?: { initials: string; displayName: string }[];
}

export interface FileVersion {
  id: string;
  fileId: string;
  number: number;
  /** Display versioning — "3.2" = major 3, minor draft 2 (check-in/out) */
  major?: number;
  minor?: number;
  /** Draft versions are hidden from viewer-level users */
  published?: boolean;
  /** Submitted for approval (content-approval libraries) */
  pending?: boolean;
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

// --- Sites (SharePoint-style site → libraries → items) ---

export type SiteRole = "owner" | "member" | "visitor";
export type SiteType = "team" | "project" | "department" | "communication";

export interface Site {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  type: SiteType;
  /** org = all org members are implicit visitors; private = members only */
  visibility: "org" | "private";
  ownerId: string;
  /** Requesting user's effective role on the site */
  myRole?: SiteRole | null;
  memberCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface SiteMember {
  userId: string;
  role: SiteRole;
  user: { displayName: string; email: string; initials: string };
  createdAt: string;
}

export interface Library {
  id: string;
  siteId: string;
  name: string;
  kind: "documents" | "media" | "form";
  /** major = every save publishes; minor = check-in/out produces drafts */
  versioning?: "major" | "minor";
  /** Content approval — member publishes become owner-reviewed submissions */
  approval?: boolean;
  /** false = unique permissions — only explicit grants reach this library */
  inheritPermissions?: boolean;
  itemCount?: number;
  createdAt: string;
}

/** Explicit per-library grant, used when a library breaks inheritance. */
export interface LibraryGrant {
  userId: string;
  role: SiteRole;
  user: { displayName: string; email: string; initials: string };
  createdAt: string;
}

/** Content type (SharePoint reusable document schema). Site-scoped types are
 *  available across all libraries in a site; library-scoped types are local. */
export interface ContentType {
  id: string;
  siteId: string | null;
  libraryId: string | null;
  name: string;
  description: string | null;
  templateBlobKey: string | null;
  allowedKinds: FileKind[];
  isDefault: boolean;
  /** Bound library columns (library-scoped GET only) */
  columns?: { columnId: string; required: boolean; position: number }[];
  createdAt: string;
}

/** Column binding on a content type, with per-type required/position overrides. */
export interface ContentTypeColumn {
  contentTypeId: string;
  columnId: string;
  required: boolean;
  position: number;
}

export type ColumnType = "text" | "number" | "date" | "choice" | "person" | "yesno";

export interface LibraryColumn {
  id: string;
  libraryId: string;
  name: string;
  type: ColumnType;
  required: boolean;
  /** Allowed values when type === 'choice' */
  choices?: string[];
  position: number;
  createdAt: string;
}

export interface ViewConfig {
  sort?: "name" | "updated" | "size";
  dir?: "asc" | "desc";
  kind?: FileKind | "";
  label?: string;
  query?: string;
  /** columnId → required value (equality filter) */
  columnFilters?: Record<string, string>;
  /** Show only items whose head draft awaits approval */
  pending?: boolean;
}

export interface LibraryView {
  id: string;
  libraryId: string;
  name: string;
  config: ViewConfig;
  createdBy: string | null;
  shared: boolean;
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
