// Kreatix Business Suite — shared domain types (SRS §4, §11, §19)

export type UserRole = "owner" | "admin" | "member" | "guest";
export type Permission = "owner" | "editor" | "reviewer" | "commenter" | "viewer";
export type FileKind = "folder" | "writer" | "sheets" | "present" | "pdf" | "board" | "file";

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
  /** email_verified flag — false until the verification link is clicked */
  emailVerified?: boolean;
  /** onboarding checklist dismissed — persists across devices */
  onboardingDismissed?: boolean;
  /** Suite apps the workspace admin has turned off for this user
   *  (SuiteApp slugs; empty/absent = every app allowed) */
  disabledApps?: string[];
  createdAt: string;
}

/** Per-user app entitlements — admin-toggleable suite apps (M365-style
 *  "licenses → apps"). `apiPrefixes` are gated server-side per request;
 *  `itemKind` gates editor open/create by the file's kind. */
export type SuiteApp =
  | "writer" | "sheets" | "present" | "board" | "pdf"
  | "mail" | "meet" | "chat" | "calendar" | "tasks" | "notes" | "forms" | "sites";

export interface SuiteAppDef {
  slug: SuiteApp;
  name: string;
  path?: string;          // SPA route — hidden from nav when disabled
  apiPrefixes?: string[]; // 403'd server-side when disabled
  itemKind?: FileKind;    // editor apps gate on the item's kind instead
}

export const SUITE_APPS: SuiteAppDef[] = [
  { slug: "writer", name: "Writer", itemKind: "writer" },
  { slug: "sheets", name: "Sheets", itemKind: "sheets" },
  { slug: "present", name: "Present", itemKind: "present" },
  { slug: "board", name: "Board", itemKind: "board" },
  { slug: "pdf", name: "PDF", itemKind: "pdf" },
  { slug: "mail", name: "Mail", path: "/mail", apiPrefixes: ["/api/mail"] },
  { slug: "meet", name: "Meet", path: "/meet", apiPrefixes: ["/api/meet"] },
  { slug: "chat", name: "Chat", path: "/chat", apiPrefixes: ["/api/chat"] },
  { slug: "calendar", name: "Calendar", path: "/calendar", apiPrefixes: ["/api/calendar"] },
  { slug: "tasks", name: "Tasks", path: "/tasks", apiPrefixes: ["/api/tasks"] },
  { slug: "notes", name: "Notes", path: "/notes", apiPrefixes: ["/api/notes"] },
  { slug: "forms", name: "Forms", path: "/forms", apiPrefixes: ["/api/forms"] },
  { slug: "sites", name: "Sites", path: "/sites", apiPrefixes: ["/api/sites"] },
];

const APP_BY_PREFIX: [SuiteApp, string][] = SUITE_APPS.flatMap((a) =>
  (a.apiPrefixes ?? []).map((p) => [a.slug, p] as [SuiteApp, string]));

/** Resolve which suite app an API path belongs to (longest prefix wins). */
export function appForApiPath(url: string): SuiteApp | undefined {
  const path = url.split("?")[0];
  let best: [SuiteApp, string] | undefined;
  for (const e of APP_BY_PREFIX)
    if (path === e[1] || path.startsWith(`${e[1]}/`))
      if (!best || e[1].length > best[1].length) best = e;
  return best?.[0];
}

/** Editor apps are gated by file kind — e.g. disabling "sheets" blocks
 *  creating/opening kind:"sheets" items. */
export function appForKind(kind: FileKind): SuiteApp | undefined {
  return SUITE_APPS.find((a) => a.itemKind === kind)?.slug;
}

export const appEnabled = (disabled: string[] | undefined, slug: SuiteApp) =>
  !disabled?.includes(slug);

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
  /** Legal hold — deletion is blocked while set */
  legalHold?: boolean;
  /** Last save matched an org DLP pattern */
  dlpFlagged?: boolean;
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
  /** Hub this site is associated with (SharePoint hub sites) */
  hubId?: string | null;
  /** Site-wide legal hold — every item in every library under it is preserved */
  legalHold?: boolean;
  hubName?: string | null;
  /** Sites associated to this site when it acts as a hub */
  associatedSites?: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Saved site blueprint — libraries + columns + content types, provisioned
 *  on demand via POST /api/sites { templateId }. Column references inside
 *  content types are by name (ids are per-library). */
export interface SiteTemplate {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  blueprint: SiteBlueprint;
  createdAt: string;
}

export interface SiteBlueprint {
  libraries: {
    name: string;
    kind: Library["kind"];
    versioning?: "major" | "minor";
    approval?: boolean;
    retentionDays?: number | null;
    columns: {
      name: string; type: ColumnType; required?: boolean;
      choices?: string[]; termSetName?: string;
    }[];
    contentTypes: {
      name: string; description?: string | null; allowedKinds: FileKind[];
      isDefault?: boolean; docSet?: boolean;
      columns?: { name: string; required?: boolean; shared?: boolean }[];
    }[];
  }[];
}

/** Library alert notification (SharePoint "Alert me"). */
export interface SiteNotification {
  id: string;
  kind: string;
  fileId: string | null;
  fileName?: string | null;
  libraryId: string | null;
  actor?: { displayName: string; initials: string } | null;
  message: string | null;
  read: boolean;
  createdAt: string;
}

export interface SiteMember {
  userId: string;
  role: SiteRole;
  user: { displayName: string; email: string; initials: string };
  createdAt: string;
}

/** Org-level group (SharePoint group) — a named set of people that can hold
 *  a site role or library grant as a unit. Admins manage membership. */
export interface OrgGroup {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  memberCount?: number;
  members?: {
    userId: string;
    user: { displayName: string; email: string; initials: string };
  }[];
  createdAt: string;
}

/** A group's grant on a site or library. */
export interface GroupGrant {
  groupId: string;
  name: string;
  role: SiteRole;
  memberCount: number;
  createdAt: string;
}

/** Effective access entry (SharePoint "Check permissions" / "Manage access")
 *  — one principal with its resolved permission and the reason(s) it applies. */
export interface AccessEntry {
  kind: "user" | "group";
  /** userId or groupId */
  id: string;
  name: string;
  email?: string;
  initials?: string;
  permission: Permission;
  /** Human-readable grant sources, e.g. "Site member", "Direct share" */
  via: string[];
  memberCount?: number;
}

/** One step in a library approval chain — "any" advances on the first
 *  signature, "all" needs every listed approver. */
export interface ApprovalStep {
  mode: "any" | "all";
  ids: string[];
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
  /** Ordered approval steps — each step is one or more approvers; "any"
   *  advances on the first signature, "all" needs every member. */
  approvalChain?: ApprovalStep[] | null;
  /** Auto-trash items untouched this many days (null = off) */
  retentionDays?: number | null;
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
  /** Document-set type — stamps folders as work-product containers whose
   *  'shared' bound columns propagate to items placed inside */
  docSet?: boolean;
  /** Bound library columns (library-scoped GET only) */
  columns?: { columnId: string; required: boolean; shared: boolean; position: number }[];
  createdAt: string;
}

/** Column binding on a content type, with per-type required/position overrides. */
export interface ContentTypeColumn {
  contentTypeId: string;
  columnId: string;
  required: boolean;
  /** doc-set shared column — value propagates from the set folder to children */
  shared?: boolean;
  position: number;
}

export type ColumnType = "text" | "number" | "date" | "choice" | "person" | "yesno" | "managed";

/** Term store (SharePoint managed metadata): org-wide vocabulary sets that
 *  managed-type library columns bind to. */
export interface TermSet {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  terms?: Term[];
  createdAt: string;
}

export interface Term {
  id: string;
  setId: string;
  parentId: string | null;
  name: string;
  position: number;
}

export interface LibraryColumn {
  id: string;
  libraryId: string;
  name: string;
  type: ColumnType;
  required: boolean;
  /** Allowed values when type === 'choice' */
  choices?: string[];
  /** Bound term set when type === 'managed' */
  termSetId?: string | null;
  position: number;
  createdAt: string;
}

export interface ViewConfig {
  sort?: "name" | "updated" | "size";
  dir?: "asc" | "desc";
  /** Sort by a custom metadata column instead of a system field */
  sortColumnId?: string;
  kind?: FileKind | "";
  label?: string;
  query?: string;
  /** columnId → required value (equality filter) */
  columnFilters?: Record<string, string>;
  /** Show only items whose head draft awaits approval */
  pending?: boolean;
  /** Group rows under collapsible headers: "label" | "kind" | "contentType" | a columnId */
  groupBy?: string;
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

export const FILE_KINDS: FileKind[] = ["writer", "sheets", "present", "pdf", "board", "file"];

export const KIND_LABELS: Record<FileKind, string> = {
  folder: "Folder",
  writer: "Kreatix Writer",
  sheets: "Kreatix Sheets",
  present: "Kreatix Present",
  pdf: "Kreatix PDF",
  board: "Kreatix Board",
  file: "File",
};

export const KIND_COLORS: Record<Exclude<FileKind, "folder">, string> = {
  writer: "#3578E5",
  sheets: "#1F9D66",
  present: "#E96A2C",
  pdf: "#D84B57",
  board: "#0E7C61",
  file: "#727272",
};
