import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, Color, FontFamily, FontSize, LineHeight, BackgroundColor } from "@tiptap/extension-text-style";
import { Highlight } from "@tiptap/extension-highlight";
import { TextAlign } from "@tiptap/extension-text-align";
import { Subscript } from "@tiptap/extension-subscript";
import { Superscript } from "@tiptap/extension-superscript";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { common, createLowlight } from "lowlight";
import { Mathematics } from "@tiptap/extension-mathematics";
import { PaginationPlus, PAGE_SIZES } from "tiptap-pagination-plus";
import { TrackChangesExtension } from "tiptap-track-changes";
import { CharacterCount } from "@tiptap/extensions";
import { TextSelection } from "@tiptap/pm/state";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import type { Comment, DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { saveContent } from "../lib/drafts";
import { useAuth } from "../lib/auth";
import { createCollabSession, colorFor, type CollabSession } from "../collab/session";
import { PresenceBar } from "../collab/PresenceBar";
import { AiPanel, type AiOp } from "../ai/AiPanel";
import { CommentMark } from "./extensions";
import { ParagraphSpacing, ListStyle } from "./extensions/spacing";
import { PageBreak } from "./extensions/nodes";
import { Footnote } from "./extensions/footnote";
import { Toc } from "./extensions/toc";
import { Embed } from "./extensions/embed";
import { RichImage } from "./extensions/image";
import { LinkPopover } from "./LinkPopover";
import { SpecialChars } from "./SpecialChars";
import { PageSetupDialog, readPageSetup, applyPageSetup } from "./PageSetup";
import { ModeSwitcher, SuggestionsBadge, SuggestionsPanel } from "./SuggestBar";
import { MenuBar, textCaseItems, type MenuItem } from "./MenuBar";
import { FontPicker, FontSizePicker, ColorSwatch, LineSpacingDrop, ZoomDrop } from "./controls";
import { Ruler } from "./Ruler";
import { exportDocx, importDocx } from "./docx";
import { ensureDocFonts } from "./fonts";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";
import "katex/dist/katex.min.css";

type SaveState = "saved" | "saving" | "unsaved" | "error";
type Panel = "none" | "comments" | "versions" | "ai" | "outline" | "suggest";

export function WriterEditor({ item, initialDoc, permission }: {
  item: DriveItem;
  initialDoc: unknown;
  permission: string;
}) {
  const navigate = useNavigate();
  const canEdit = permission === "owner" || permission === "editor";
  const forcedMode = permission === "reviewer" ? "suggest" : undefined;
  const { msg, toast } = useToast();
  const [title, setTitle] = useState(item.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [panel, setPanel] = useState<Panel>("none");
  const [sharing, setSharing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wordCountOpen, setWordCountOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [specialChars, setSpecialChars] = useState(false);
  const [pageSetupOpen, setPageSetupOpen] = useState(false);
  const [zoom, setZoom] = useState(100);
  const importRef = useRef<HTMLInputElement>(null);
  const textImportRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const pendingJson = useRef<unknown>(null);
  const editorRef = useRef<Editor | null>(null);

  // collab session — created synchronously so useEditor can bind the Y.Doc
  const { user } = useAuth();
  const sessionRef = useRef<CollabSession | null>(null);
  if (user && !sessionRef.current) sessionRef.current = createCollabSession(item.id, user);
  const session = sessionRef.current;
  useEffect(() => () => { sessionRef.current?.destroy(); sessionRef.current = null; }, []);

  const editor = useEditor({
    editable: canEdit,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        codeBlock: false,
        link: { openOnClick: false, autolink: true, linkOnPaste: true },
      }),
      TextStyle, Color, FontFamily, FontSize, LineHeight, BackgroundColor,
      Highlight.configure({ multicolor: true }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Subscript, Superscript,
      TaskList, TaskItem.configure({ nested: true }),
      Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
      RichImage,
      CodeBlockLowlight.configure({ lowlight: createLowlight(common) }),
      Mathematics,
      CharacterCount,
      CommentMark,
      ParagraphSpacing,
      ListStyle,
      PageBreak,
      Footnote,
      Toc,
      Embed,
      PaginationPlus.configure({
        ...PAGE_SIZES.LETTER,
        pageGap: 24,
        pageGapBorderSize: 1,
        pageGapBorderColor: "#E5DED6",
        pageBreakBackground: "#F4F0EC",
        footerRight: "Page {page} of {total}",
      }),
      TrackChangesExtension.configure({
        author: {
          id: user?.id ?? "anon",
          name: user?.displayName ?? "Anonymous",
          color: colorFor(user?.id ?? "anon"),
        },
        // reviewers land in suggesting mode; everyone else edits directly
        mode: permission === "reviewer" ? "suggest" : "edit",
        additionalBlockTypes: ["taskList", "taskItem", "table", "tableRow", "tableCell", "tableHeader", "horizontalRule", "pageBreak", "toc", "embed", "blockMath"],
      }),
      ...(session ? [
        Collaboration.configure({ document: session.ydoc, field: "default" }),
        CollaborationCaret.configure({ provider: session.provider, user: { ...session.user } }),
      ] : []),
    ],
    // collab mode: content is driven by the shared Y.Doc (seeded after sync)
    content: session ? undefined : ((initialDoc as { doc?: object })?.doc ?? (initialDoc as object)),
    onUpdate: ({ editor }) => {
      pendingJson.current = { kind: "writer", doc: editor.getJSON(), pageSetup: readPageSetup(editor) };
      setSaveState("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flushSave, 1200);
    },
    editorProps: {
      attributes: { "aria-label": "Document editor", spellcheck: "true" },
      // paste / drag-drop an image → upload to Drive as doc media
      handlePaste: (_view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
        if (file) { void uploadImage(file); return true; }
        return false;
      },
      handleDrop: (_view, event) => {
        const file = [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));
        if (file) { event.preventDefault(); void uploadImage(file); return true; }
        return false;
      },
    },
  });
  editorRef.current = editor;

  /** Upload an image as Drive media owned by this doc, then embed it.
   *  Falls back to a data URL if the upload gate rejects it. */
  const uploadImage = useCallback(async (f: File) => {
    try {
      const r = await api.upload<{ item: { id: string } }>(
        `/api/drive/upload?name=${encodeURIComponent(f.name || "image")}&kind=file&mediaFor=${item.id}`, f);
      editorRef.current?.chain().focus().setImage({ src: `/api/files/${r.item.id}/raw`, alt: f.name }).run();
    } catch {
      const url = await new Promise<string>((res) => {
        const rd = new FileReader();
        rd.onload = () => res(rd.result as string);
        rd.readAsDataURL(f);
      });
      editorRef.current?.chain().focus().setImage({ src: url }).run();
    }
  }, [item.id]);

  // load fonts referenced by the doc so it renders correctly for viewers
  useEffect(() => { ensureDocFonts(initialDoc); }, [initialDoc]);

  // restore saved page setup once the editor exists (collab or solo)
  useEffect(() => {
    const setup = (initialDoc as { pageSetup?: Parameters<typeof applyPageSetup>[1] })?.pageSetup;
    if (editor && setup) applyPageSetup(editor, setup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  // migrate legacy data-URL images to Drive media — uploads under this doc's
  // media_for and rewrites src to /api/files/:id/raw so bytes leave the JSON
  const migratedImages = useRef(false);
  useEffect(() => {
    if (!editor || !canEdit || migratedImages.current) return;
    migratedImages.current = true;
    void (async () => {
      for (;;) {
        let src: string | null = null;
        editor.state.doc.descendants((node) => {
          if (src === null && node.type.name === "image" && String(node.attrs.src ?? "").startsWith("data:"))
            src = node.attrs.src as string;
          return src === null;
        });
        if (src === null) break;
        try {
          const [meta, b64] = (src as string).split(",", 2);
          const mime = meta.match(/data:(.*?);/)?.[1] ?? "image/png";
          const bytes = Uint8Array.from(atob(b64 ?? ""), (c) => c.charCodeAt(0));
          const file = new File([bytes], `image.${mime.split("/")[1] ?? "png"}`, { type: mime });
          const r = await api.upload<{ item: { id: string } }>(
            `/api/drive/upload?name=${encodeURIComponent(file.name)}&kind=file&mediaFor=${item.id}`, file);
          const oldSrc = src;
          editor.chain().command(({ tr }) => {
            let done = false;
            editor.state.doc.descendants((node, pos) => {
              if (done) return false;
              if (node.type.name === "image" && node.attrs.src === oldSrc) {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: `/api/files/${r.item.id}/raw` });
                done = true;
              }
              return true;
            });
            return done;
          }).run();
        } catch {
          break; // offline or upload gate — leave the data URL in place
        }
      }
    })();
  }, [editor, canEdit, item.id]);

  // page-setup changes only mutate extension storage — stage the save manually
  const savePageSetup = useCallback(() => {
    if (!editorRef.current) return;
    pendingJson.current = {
      kind: "writer",
      doc: editorRef.current.getJSON(),
      pageSetup: readPageSetup(editorRef.current),
    };
    setSaveState("unsaved");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 800);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // seed the shared doc from canonical JSON — exactly once, lowest clientID wins
  useEffect(() => {
    if (!session || !editor) return;
    const frag = session.ydoc.getXmlFragment("default");
    const meta = session.ydoc.getMap<unknown>("meta");
    const seed = () => {
      if (frag.length || meta.get("seeded")) return;
      const json = ((initialDoc as { doc?: object })?.doc ?? initialDoc) as { type?: string } | null;
      session.ydoc.transact(() => {
        if (json?.type === "doc") {
          const tmp = prosemirrorJSONToYDoc(editor.schema, json, "default");
          Y.applyUpdate(session.ydoc, Y.encodeStateAsUpdate(tmp));
        }
        meta.set("seeded", true);
      });
    };
    let done = false;
    const elect = () => {
      if (done || frag.length || meta.get("seeded")) return;
      const ids = [...session.awareness.getStates().keys()];
      if (Math.min(...ids) === session.awareness.clientID) { done = true; seed(); }
    };
    void session.whenSynced.then(() => setTimeout(elect, 150));
    const t = setTimeout(() => { done = true; seed(); }, 2500); // offline fallback
    return () => clearTimeout(t);
  }, [session, editor, initialDoc]);

  const flushSave = useCallback(async () => {
    if (!pendingJson.current) return;
    const payload = pendingJson.current;
    pendingJson.current = null;
    setSaveState("saving");
    const ok = await saveContent(item.id, payload, !!session);
    if (ok) setSaveState("saved");
    else {
      pendingJson.current = payload; // re-stage so the retry carries these edits
      setSaveState("error");
      toast(navigator.onLine
        ? "Could not save — will retry on next edit"
        : "Offline — changes saved locally, syncing on reconnect");
    }
  }, [item.id, session, toast]);

  // replay pending saves when connectivity returns
  useEffect(() => {
    const on = () => { void flushSave(); };
    window.addEventListener("online", on);
    return () => window.removeEventListener("online", on);
  }, [flushSave]);

  // global editor shortcuts the browser would otherwise steal
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === "f" || k === "h") {
        e.preventDefault();
        setFindOpen(true);
      } else if (k === "s") {
        e.preventDefault();
        if (saveTimer.current) clearTimeout(saveTimer.current);
        void flushSave();
      } else if (k === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flushSave]);

  // flush on unmount / pagehide (autosave durability, KBS-SHARED-003)
  useEffect(() => {
    const flush = () => { if (saveTimer.current) { clearTimeout(saveTimer.current); flushSave(); } };
    window.addEventListener("beforeunload", flush);
    return () => { window.removeEventListener("beforeunload", flush); flush(); };
  }, [flushSave]);

  const loadComments = useCallback(async () => {
    const r = await api.get<{ comments: Comment[] }>(`/api/files/${item.id}/comments`);
    setComments(r.comments);
  }, [item.id]);

  useEffect(() => { loadComments().catch(() => {}); }, [loadComments]);

  const rename = useCallback(async (name: string) => {
    await api.patch(`/api/drive/${item.id}`, { name });
  }, [item.id]);

  const state = useEditorState({
    editor,
    selector: (ctx) => ({
      words: ctx.editor?.storage.characterCount?.words() ?? 0,
      chars: ctx.editor?.storage.characterCount?.characters() ?? 0,
      canUndo: ctx.editor?.can().undo() ?? false,
      canRedo: ctx.editor?.can().redo() ?? false,
      bold: ctx.editor?.isActive("bold") ?? false,
      italic: ctx.editor?.isActive("italic") ?? false,
      underline: ctx.editor?.isActive("underline") ?? false,
      strike: ctx.editor?.isActive("strike") ?? false,
      code: ctx.editor?.isActive("code") ?? false,
      sub: ctx.editor?.isActive("subscript") ?? false,
      sup: ctx.editor?.isActive("superscript") ?? false,
      highlight: ctx.editor?.isActive("highlight") ?? false,
      bullet: ctx.editor?.isActive("bulletList") ?? false,
      ordered: ctx.editor?.isActive("orderedList") ?? false,
      taskList: ctx.editor?.isActive("taskList") ?? false,
      quote: ctx.editor?.isActive("blockquote") ?? false,
      codeBlock: ctx.editor?.isActive("codeBlock") ?? false,
      link: ctx.editor?.isActive("link") ?? false,
      block: ctx.editor?.isActive("heading", { level: 1 }) ? "h1"
        : ctx.editor?.isActive("heading", { level: 2 }) ? "h2"
        : ctx.editor?.isActive("heading", { level: 3 }) ? "h3"
        : ctx.editor?.isActive("heading", { level: 4 }) ? "h4"
        : ctx.editor?.isActive("heading", { level: 5 }) ? "h5"
        : ctx.editor?.isActive("heading", { level: 6 }) ? "h6"
        : ctx.editor?.isActive("blockquote") ? "quote"
        : ctx.editor?.isActive("codeBlock") ? "code" : "p",
      align: ctx.editor?.isActive({ textAlign: "center" }) ? "center"
        : ctx.editor?.isActive({ textAlign: "right" }) ? "right"
        : ctx.editor?.isActive({ textAlign: "justify" }) ? "justify" : "left",
      font: (ctx.editor?.getAttributes("textStyle").fontFamily as string) ?? "",
      fontSize: (ctx.editor?.getAttributes("textStyle").fontSize as string) ?? "",
      color: (ctx.editor?.getAttributes("textStyle").color as string) ?? "",
      bgColor: (ctx.editor?.getAttributes("highlight").color as string) ?? "",
      inTable: ctx.editor?.isActive("table") ?? false,
      image: ctx.editor?.isActive("image") ?? false,
      paged: (ctx.editor?.storage.PaginationPlus?.enabled as boolean) ?? false,
    }),
  });

  // ---- find & replace (KBS-WRITER-017) ----
  const matches = useMemo(() => {
    if (!editor || !query) return [] as { from: number; to: number }[];
    const out: { from: number; to: number }[] = [];
    const needle = matchCase ? query : query.toLowerCase();
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      const hay = matchCase ? node.text : node.text.toLowerCase();
      let i = hay.indexOf(needle);
      while (i !== -1) {
        out.push({ from: pos + i, to: pos + i + needle.length });
        i = hay.indexOf(needle, i + 1);
      }
    });
    return out;
  }, [editor, query, matchCase, state]);

  const jump = useCallback((dir: 1 | -1) => {
    if (!editor || !matches.length) return;
    const { from, to } = editor.state.selection;
    const next = dir === 1
      ? matches.find((m) => m.from >= to) ?? matches[0]
      : [...matches].reverse().find((m) => m.to <= from) ?? matches[matches.length - 1];
    editor.chain().focus().command(({ tr }) => {
      tr.setSelection(TextSelection.create(tr.doc, next.from, next.to)).scrollIntoView();
      return true;
    }).run();
  }, [editor, matches]);

  const replaceCurrent = useCallback((all: boolean) => {
    if (!editor || !canEdit) return;
    if (all) {
      editor.chain().focus().command(({ tr }) => {
        [...matches].reverse().forEach((m) => tr.insertText(replace, m.from, m.to));
        return true;
      }).run();
      toast(`Replaced ${matches.length} occurrence${matches.length === 1 ? "" : "s"}`);
    } else {
      const { from, to } = editor.state.selection;
      const sel = editor.state.doc.textBetween(from, to);
      const same = matchCase ? sel === query : sel.toLowerCase() === query.toLowerCase();
      if (same) {
        editor.chain().focus().insertContentAt({ from, to }, replace).run();
      }
      jump(1);
    }
  }, [editor, matches, query, replace, canEdit, jump, toast, matchCase]);

  // ---- comments ----
  const startComment = () => {
    if (editor && !editor.state.selection.empty) {
      setNewComment(true);
      setPanel("comments");
    } else {
      toast("Select some text to comment on");
    }
  };

  const submitComment = async (body: string) => {
    if (!editor) return;
    const anchor = crypto.randomUUID();
    editor.chain().focus().setComment(anchor).run();
    await api.post(`/api/files/${item.id}/comments`, { body, anchor });
    setNewComment(false);
    loadComments();
  };

  const focusAnchor = (anchor: string) => {
    if (!editor) return;
    document.querySelectorAll(".comment-mark").forEach((el) => el.classList.remove("active"));
    const el = document.querySelector(`.comment-mark[data-comment-id="${anchor}"]`);
    el?.classList.add("active");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // ---- AI ops (tool-constrained edits; applied via editor → undo/autosave/collab all work) ----
  const aiApplyOps = useCallback((ops: AiOp[]) => {
    if (!editor) return;
    for (const o of ops) {
      if (o.op === "find_replace") {
        const needle = String(o.find);
        const matches: { from: number; to: number }[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (!node.isTextblock) return;
          const chars: string[] = [];
          const posMap: number[] = [];
          node.forEach((child, off) => {
            if (child.isText && child.text) {
              chars.push(child.text);
              for (let i = 0; i < child.text.length; i++) posMap.push(pos + 1 + off + i);
            } else {
              chars.push(" ");
              posMap.push(pos + 1 + off);
            }
          });
          const t = chars.join("");
          let i = t.indexOf(needle);
          while (i !== -1) {
            matches.push({ from: posMap[i], to: posMap[i + needle.length - 1] + 1 });
            if (!o.all) return false;
            i = t.indexOf(needle, i + needle.length);
          }
          return false;
        });
        const use = o.all ? matches : matches.slice(0, 1);
        editor.chain().focus().command(({ tr }) => {
          [...use].reverse().forEach((m) => tr.insertText(String(o.replace ?? ""), m.from, m.to));
          return true;
        }).run();
      } else if (o.op === "insert_table") {
        const rows = Math.min(20, Math.max(1, Number(o.rows) || 2));
        const cols = Math.min(8, Math.max(1, Number(o.cols) || 2));
        const table = {
          type: "table",
          content: Array.from({ length: rows }, () => ({
            type: "tableRow",
            content: Array.from({ length: cols }, () => ({
              type: "tableCell", content: [{ type: "paragraph" }],
            })),
          })),
        };
        editor.chain().focus().insertContentAt(editor.state.doc.nodeSize - 2, table).run();
      } else if (o.op === "append_paragraph" || o.op === "insert_heading") {
        editor.chain().focus().insertContentAt(editor.state.doc.nodeSize - 2,
          o.op === "insert_heading"
            ? { type: "heading", attrs: { level: o.level }, content: [{ type: "text", text: String(o.text) }] }
            : { type: "paragraph", content: [{ type: "text", text: String(o.text) }] }).run();
      } else if (o.op === "prepend_paragraph") {
        editor.chain().focus().insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: String(o.text) }] }).run();
      } else if (o.op === "replace_selection") {
        const { from, to } = editor.state.selection;
        if (to > from) editor.chain().focus().insertContentAt({ from, to }, String(o.text)).run();
      } else if (o.op === "insert_content") {
        try {
          const content = typeof o.content === "string" ? JSON.parse(o.content) : o.content;
          editor.chain().focus().insertContent(content).run();
        } catch { /* malformed AI content — skip */ }
      }
    }
  }, [editor]);

  // ---- imports/exports ----
  const onImport = async (f: File) => {
    try {
      const html = await importDocx(f);
      editor?.commands.setContent(html);
      toast(`Imported ${f.name}`);
    } catch {
      toast("Could not import that file");
    }
  };

  const onTextImport = async (f: File) => {
    try {
      const text = await f.text();
      const ext = f.name.split(".").pop()?.toLowerCase();
      if (ext === "md") {
        const { mdToHtml } = await import("./export/markdown");
        editor?.commands.setContent(mdToHtml(text));
      } else if (ext === "html" || ext === "htm") {
        editor?.commands.setContent(text);
      } else {
        editor?.commands.setContent(`<p>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br>")}</p>`);
      }
      toast(`Imported ${f.name}`);
    } catch {
      toast("Could not import that file");
    }
  };

  const onImage = (f: File) => void uploadImage(f);

  const download = async (fmt: string) => {
    if (!editor) return;
    const json = editor.getJSON() as never;
    const name = title;
    try {
      if (fmt === "docx") return exportDocx(json, name);
      const mod = await import("./export/index");
      if (fmt === "md") return mod.downloadMd(json, name);
      if (fmt === "html") return mod.downloadHtml(name, editor.getHTML(), readPageSetup(editor));
      if (fmt === "txt") return mod.downloadTxt(editor, name);
      if (fmt === "rtf") return mod.downloadRtf(json, name);
      if (fmt === "odt") return mod.downloadOdt(json, name);
      if (fmt === "pdf") {
        // clone the rendered (paginated) DOM — headers/footers/page numbers
        // and KaTeX all carry over; strip editing-only attrs
        const clone = editor.view.dom.cloneNode(true) as HTMLElement;
        clone.removeAttribute("contenteditable");
        clone.removeAttribute("spellcheck");
        clone.querySelectorAll(".img-resize-handle").forEach((el) => el.remove());
        clone.querySelectorAll("[contenteditable],[data-drag-handle]")
          .forEach((el) => { el.removeAttribute("contenteditable"); el.removeAttribute("data-drag-handle"); });
        return mod.exportPdf(clone.outerHTML, name, readPageSetup(editor));
      }
    } catch (e) {
      toast(`Export failed: ${(e as Error).message.slice(0, 60)}`);
    }
  };

  const print = () => { download("pdf"); };

  const setBlock = (v: string) => {
    const c = editor?.chain().focus();
    if (!c) return;
    if (v === "p") c.setParagraph().run();
    else if (v === "quote") c.toggleBlockquote().run();
    else if (v === "code") c.toggleCodeBlock().run();
    else c.toggleHeading({ level: Number(v[1]) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
  };

  const insertLink = () => {
    const prev = editor?.getAttributes("link").href as string | undefined;
    const url = prompt("Link URL:", prev ?? "https://");
    if (url === null) return;
    if (!url.trim()) editor?.chain().focus().unsetLink().run();
    else editor?.chain().focus().setLink({ href: url.trim() }).run();
  };

  // ---- outline pane data ----
  const outline = useMemo(() => {
    if (!editor) return [] as { pos: number; level: number; text: string }[];
    const out: { pos: number; level: number; text: string }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === "heading") {
        out.push({ pos, level: node.attrs.level as number, text: node.textContent || "(empty heading)" });
      }
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, state?.words]);

  const jumpTo = (pos: number) => {
    editor?.chain().focus().command(({ tr }) => {
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 1))).scrollIntoView();
      return true;
    }).run();
  };

  // ---- menubar model ----
  const ed = editor;
  const menus = useMemo<{ label: string; items: MenuItem[] }[]>(() => {
    if (!ed) return [];
    const headingItem = (n: number): MenuItem => ({
      label: `Heading ${n}`, checked: state?.block === `h${n}`,
      onClick: () => ed.chain().focus().toggleHeading({ level: n as 1 }).run(),
    });
    return [
      {
        label: "File", items: [
          { label: "Import .docx…", onClick: () => importRef.current?.click() },
          { label: "Import text (.md / .txt / .html)…", onClick: () => textImportRef.current?.click() },
          {
            label: "Download", submenu: [
              { label: "Microsoft Word (.docx)", onClick: () => void download("docx") },
              { label: "PDF document (.pdf)", onClick: () => void download("pdf") },
              { divider: true },
              { label: "Markdown (.md)", onClick: () => void download("md") },
              { label: "Web page (.html)", onClick: () => void download("html") },
              { label: "Rich Text (.rtf)", onClick: () => void download("rtf") },
              { label: "OpenDocument (.odt)", onClick: () => void download("odt") },
              { label: "Plain text (.txt)", onClick: () => void download("txt") },
            ],
          },
          { label: "Print", shortcut: "Ctrl+P", onClick: print },
          { divider: true },
          { label: "Page setup…", onClick: () => setPageSetupOpen(true) },
          { divider: true },
          { label: "Share…", onClick: () => setSharing(true) },
          { label: "Version history", checked: panel === "versions", onClick: () => setPanel(panel === "versions" ? "none" : "versions") },
        ],
      },
      {
        label: "Edit", items: [
          { label: "Undo", shortcut: "Ctrl+Z", disabled: !state?.canUndo, onClick: () => ed.chain().focus().undo().run() },
          { label: "Redo", shortcut: "Ctrl+Y", disabled: !state?.canRedo, onClick: () => ed.chain().focus().redo().run() },
          { divider: true },
          { label: "Cut", shortcut: "Ctrl+X", onClick: () => document.execCommand("cut") },
          { label: "Copy", shortcut: "Ctrl+C", onClick: () => document.execCommand("copy") },
          { label: "Select all", shortcut: "Ctrl+A", onClick: () => ed.chain().focus().selectAll().run() },
          { divider: true },
          { label: "Find and replace", shortcut: "Ctrl+F", checked: findOpen, onClick: () => setFindOpen(true) },
        ],
      },
      {
        label: "View", items: [
          { label: "Print layout", checked: state?.paged, onClick: () => { ed.chain().focus().togglePagination().run(); } },
          { label: "Show outline", checked: panel === "outline", onClick: () => setPanel(panel === "outline" ? "none" : "outline") },
          { divider: true },
          { label: "Word count", onClick: () => setWordCountOpen(true) },
        ],
      },
      {
        label: "Insert", items: [
          {
            label: "Image", submenu: [
              { label: "Upload from computer", onClick: () => imageRef.current?.click() },
              {
                label: "By URL…", onClick: () => {
                  const url = prompt("Image URL:", "https://");
                  if (url?.trim()) ed.chain().focus().setImage({ src: url.trim() }).run();
                }
              },
            ],
          },
          {
            label: "Table", submenu: [2, 3, 4, 5, 6, 8].map((n) => ({
              label: `${n} × ${n}`,
              onClick: () => ed.chain().focus().insertTable({ rows: n, cols: n, withHeaderRow: true }).run(),
            })),
          },
          { label: "Link", shortcut: "Ctrl+K", checked: state?.link, onClick: insertLink },
          { divider: true },
          { label: "Inline math  $x^2$", onClick: () => ed.chain().focus().insertInlineMath({ latex: "" }).run() },
          { label: "Display math", onClick: () => ed.chain().focus().insertBlockMath({ latex: "" }).run() },
          {
            label: "Footnote", onClick: () => {
              const note = prompt("Footnote text:");
              if (note !== null) ed.chain().focus().insertFootnote(note).run();
            },
          },
          { label: "Table of contents", onClick: () => ed.chain().focus().insertToc().run() },
          {
            label: "Embed (YouTube / URL)…", onClick: () => {
              const url = prompt("Embed URL:", "https://");
              if (url?.trim()) ed.chain().focus().insertEmbed(url.trim()).run();
            },
          },
          { divider: true },
          { label: "Page break", shortcut: "Ctrl+Enter", onClick: () => ed.chain().focus().setPageBreak().run() },
          { label: "Horizontal rule", onClick: () => ed.chain().focus().setHorizontalRule().run() },
          { label: "Code block", checked: state?.codeBlock, onClick: () => ed.chain().focus().toggleCodeBlock().run() },
          { label: "Special characters…", onClick: () => setSpecialChars(true) },
        ],
      },
      {
        label: "Format", items: [
          {
            label: "Text", submenu: [
              { label: "Bold", shortcut: "Ctrl+B", checked: state?.bold, onClick: () => ed.chain().focus().toggleBold().run() },
              { label: "Italic", shortcut: "Ctrl+I", checked: state?.italic, onClick: () => ed.chain().focus().toggleItalic().run() },
              { label: "Underline", shortcut: "Ctrl+U", checked: state?.underline, onClick: () => ed.chain().focus().toggleUnderline().run() },
              { label: "Strikethrough", checked: state?.strike, onClick: () => ed.chain().focus().toggleStrike().run() },
              { label: "Inline code", checked: state?.code, onClick: () => ed.chain().focus().toggleCode().run() },
              { divider: true },
              { label: "Superscript", checked: state?.sup, onClick: () => ed.chain().focus().toggleSuperscript().run() },
              { label: "Subscript", checked: state?.sub, onClick: () => ed.chain().focus().toggleSubscript().run() },
              { divider: true },
              ...textCaseItems(ed),
              { divider: true },
              { label: "Clear formatting", shortcut: "Ctrl+\\", onClick: () => ed.chain().focus().unsetAllMarks().clearNodes().run() },
            ],
          },
          {
            label: "Paragraph styles", submenu: [
              { label: "Normal text", checked: state?.block === "p", onClick: () => ed.chain().focus().setParagraph().run() },
              { label: "Quote", checked: state?.block === "quote", onClick: () => ed.chain().focus().toggleBlockquote().run() },
              { divider: true },
              ...[1, 2, 3, 4, 5, 6].map(headingItem),
            ],
          },
          {
            label: "Align & indent", submenu: [
              { label: "Left", checked: state?.align === "left", onClick: () => ed.chain().focus().setTextAlign("left").run() },
              { label: "Center", checked: state?.align === "center", onClick: () => ed.chain().focus().setTextAlign("center").run() },
              { label: "Right", checked: state?.align === "right", onClick: () => ed.chain().focus().setTextAlign("right").run() },
              { label: "Justify", checked: state?.align === "justify", onClick: () => ed.chain().focus().setTextAlign("justify").run() },
              { divider: true },
              { label: "Increase indent", onClick: () => ed.chain().focus().increaseIndent().run() },
              { label: "Decrease indent", onClick: () => ed.chain().focus().decreaseIndent().run() },
            ],
          },
          {
            label: "Lists", submenu: [
              { label: "Bulleted list", checked: state?.bullet, onClick: () => ed.chain().focus().toggleBulletList().run() },
              { label: "Numbered list", checked: state?.ordered, onClick: () => ed.chain().focus().toggleOrderedList().run() },
              { label: "Checklist", checked: state?.taskList, onClick: () => ed.chain().focus().toggleTaskList().run() },
              { divider: true },
              ...(state?.bullet ? [
                { label: "● Disc", onClick: () => ed.chain().focus().setListStyle("disc").run() },
                { label: "○ Circle", onClick: () => ed.chain().focus().setListStyle("circle").run() },
                { label: "■ Square", onClick: () => ed.chain().focus().setListStyle("square").run() },
              ] : []),
              ...(state?.ordered ? [
                { label: "1. Decimal", onClick: () => ed.chain().focus().setListStyle("decimal").run() },
                { label: "a. Lower alpha", onClick: () => ed.chain().focus().setListStyle("lower-alpha").run() },
                { label: "i. Lower roman", onClick: () => ed.chain().focus().setListStyle("lower-roman").run() },
                { label: "A. Upper alpha", onClick: () => ed.chain().focus().setListStyle("upper-alpha").run() },
                { label: "I. Upper roman", onClick: () => ed.chain().focus().setListStyle("upper-roman").run() },
              ] : []),
            ],
          },
          {
            label: "Table", submenu: state?.inTable ? [
              { label: "Insert row above", onClick: () => ed.chain().focus().addRowBefore().run() },
              { label: "Insert row below", onClick: () => ed.chain().focus().addRowAfter().run() },
              { label: "Insert column left", onClick: () => ed.chain().focus().addColumnBefore().run() },
              { label: "Insert column right", onClick: () => ed.chain().focus().addColumnAfter().run() },
              { divider: true },
              { label: "Delete row", onClick: () => ed.chain().focus().deleteRow().run() },
              { label: "Delete column", onClick: () => ed.chain().focus().deleteColumn().run() },
              { divider: true },
              { label: "Merge cells", onClick: () => ed.chain().focus().mergeCells().run() },
              { label: "Split cell", onClick: () => ed.chain().focus().splitCell().run() },
              { label: "Toggle header row", onClick: () => ed.chain().focus().toggleHeaderRow().run() },
              { label: "Toggle header column", onClick: () => ed.chain().focus().toggleHeaderColumn().run() },
              { divider: true },
              { label: "Delete table", danger: true, onClick: () => ed.chain().focus().deleteTable().run() },
            ] : [{ label: "Click inside a table first", disabled: true }],
          },
          {
            label: "Image", submenu: state?.image ? [
              { label: "Align left", onClick: () => ed.chain().focus().setImageAlign("left").run() },
              { label: "Align center", onClick: () => ed.chain().focus().setImageAlign("center").run() },
              { label: "Align right", onClick: () => ed.chain().focus().setImageAlign("right").run() },
              { label: "Inline (no wrap)", onClick: () => ed.chain().focus().setImageAlign("none").run() },
              { divider: true },
              { label: "Size ▸ 25%", onClick: () => ed.chain().focus().setImageWidth(220).run() },
              { label: "Size ▸ 50%", onClick: () => ed.chain().focus().setImageWidth(440).run() },
              { label: "Size ▸ 75%", onClick: () => ed.chain().focus().setImageWidth(660).run() },
              { label: "Full width", onClick: () => ed.chain().focus().setImageWidth(null).run() },
              { divider: true },
              {
                label: "Alt text…", onClick: () => {
                  const alt = prompt("Alt text:", (ed.getAttributes("image").alt as string) ?? "");
                  if (alt !== null) ed.chain().focus().updateAttributes("image", { alt }).run();
                },
              },
              {
                label: "Caption…", onClick: () => {
                  const cap = prompt("Caption:", (ed.getAttributes("image").caption as string) ?? "");
                  if (cap !== null) ed.chain().focus().updateAttributes("image", { caption: cap }).run();
                },
              },
            ] : [{ label: "Select an image first", disabled: true }],
          },
        ],
      },
      {
        label: "Tools", items: [
          { label: "Word count", onClick: () => setWordCountOpen(true) },
          { label: "Comments", checked: panel === "comments", onClick: () => setPanel(panel === "comments" ? "none" : "comments") },
          { label: "Kreatix AI", checked: panel === "ai", onClick: () => setPanel(panel === "ai" ? "none" : "ai") },
          { divider: true },
          { label: "Review suggestions", checked: panel === "suggest", onClick: () => setPanel(panel === "suggest" ? "none" : "suggest") },
          {
            label: "Accept all suggestions", onClick: () =>
              (ed.commands as unknown as Record<string, () => boolean>).acceptAll(),
          },
          {
            label: "Reject all suggestions", onClick: () =>
              (ed.commands as unknown as Record<string, () => boolean>).rejectAll(),
          },
          { divider: true },
          { label: "Keyboard shortcuts", shortcut: "Ctrl+/", onClick: () => setShortcutsOpen(true) },
        ],
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ed, state, panel, findOpen]);

  const saveLabel: Record<SaveState, string> = {
    saved: "All changes saved",
    saving: "Saving…",
    unsaved: "Unsaved changes",
    error: "Save failed",
  };

  return (
    <div className="editor-shell">
      <div className="editor-top">
        <button className="back" onClick={() => navigate(-1)} title="Back">←</button>
        <div className="app-ico writer" style={{ width: 34, height: 34, borderRadius: 10, fontSize: 13 }}>W</div>
        <input className="doc-title" value={title} disabled={!canEdit}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== item.name && rename(title.trim())}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
        <span className={`save-state ${saveState === "saving" || saveState === "unsaved" ? "saving" : ""}`}>
          {saveLabel[saveState]}
        </span>
        {permission !== "owner" && <span className="perm-badge">{permission}</span>}
        <PresenceBar session={session} />
        <div className="spacer" />
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-primary btn-sm" onClick={() => void download("docx")}>Export .docx</button>
      </div>

      <MenuBar items={menus} />

      {canEdit && (
        <div className="ribbon">
          <button className="rb" title="Undo (Ctrl+Z)" disabled={!state?.canUndo} onClick={() => editor?.chain().focus().undo().run()}>↶</button>
          <button className="rb" title="Redo (Ctrl+Y)" disabled={!state?.canRedo} onClick={() => editor?.chain().focus().redo().run()}>↷</button>
          <button className="rb" title="Print / PDF (Ctrl+P)" onClick={print}>🖨</button>
          <div className="rb-sep" />
          <ZoomDrop zoom={zoom} onZoom={setZoom} />
          <div className="rb-sep" />
          <select className="rb-sel" value={state?.block ?? "p"} onChange={(e) => setBlock(e.target.value)} title="Style">
            <option value="p">Normal</option>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={`h${n}`}>Heading {n}</option>)}
            <option value="quote">Quote</option>
            <option value="code">Code block</option>
          </select>
          {editor && <FontPicker editor={editor} current={state?.font ?? ""} />}
          {editor && <FontSizePicker editor={editor} current={state?.fontSize ?? ""} />}
          <div className="rb-sep" />
          <button className={`rb ${state?.bold ? "on" : ""}`} title="Bold (Ctrl+B)" onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
          <button className={`rb ${state?.italic ? "on" : ""}`} title="Italic (Ctrl+I)" onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
          <button className={`rb ${state?.underline ? "on" : ""}`} title="Underline (Ctrl+U)" onClick={() => editor?.chain().focus().toggleUnderline().run()}><u>U</u></button>
          <button className={`rb ${state?.strike ? "on" : ""}`} title="Strikethrough" onClick={() => editor?.chain().focus().toggleStrike().run()}><s>S</s></button>
          {editor && <ColorSwatch editor={editor} kind="color" current={state?.color ?? ""} />}
          {editor && <ColorSwatch editor={editor} kind="highlight" current={state?.bgColor ?? ""} />}
          <div className="rb-sep" />
          <button className={`rb ${state?.link ? "on" : ""}`} title="Link (Ctrl+K)" onClick={insertLink}>🔗</button>
          <button className="rb" title="Add comment" onClick={startComment}>💬</button>
          <button className="rb" title="Insert image" onClick={() => imageRef.current?.click()}>🖼</button>
          <button className="rb" title="Insert table" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>⊞</button>
          <div className="rb-sep" />
          {(["left", "center", "right", "justify"] as const).map((a) => (
            <button key={a} className={`rb ${a === "right" || a === "justify" ? "rb-opt2" : ""} ${state?.align === a ? "on" : ""}`} title={`Align ${a}`}
              onClick={() => editor?.chain().focus().setTextAlign(a).run()}>
              {a === "left" ? "⇤" : a === "center" ? "≡" : a === "right" ? "⇥" : "☰"}
            </button>
          ))}
          {editor && <LineSpacingDrop editor={editor} />}
          <button className={`rb rb-opt2 ${state?.taskList ? "on" : ""}`} title="Checklist" onClick={() => editor?.chain().focus().toggleTaskList().run()}>☑</button>
          <button className={`rb rb-opt2 ${state?.bullet ? "on" : ""}`} title="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()}>•≡</button>
          <button className={`rb rb-opt2 ${state?.ordered ? "on" : ""}`} title="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1≡</button>
          <button className="rb rb-opt" title="Decrease indent" onClick={() => editor?.chain().focus().decreaseIndent().run()}>⇤−</button>
          <button className="rb rb-opt" title="Increase indent" onClick={() => editor?.chain().focus().increaseIndent().run()}>⇥+</button>
          <div className="rb-sep" />
          <button className={`rb rb-opt ${state?.sup ? "on" : ""}`} title="Superscript" onClick={() => editor?.chain().focus().toggleSuperscript().run()}>x²</button>
          <button className={`rb rb-opt ${state?.sub ? "on" : ""}`} title="Subscript" onClick={() => editor?.chain().focus().toggleSubscript().run()}>x₂</button>
          <button className="rb rb-opt" title="Clear formatting" onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}>⌫</button>
          <div className="ribbon-end">
            {editor && <SuggestionsBadge editor={editor} onOpenPanel={() => setPanel("suggest")} />}
            {editor && <ModeSwitcher editor={editor} canEdit={canEdit} forced={forcedMode} />}
            <span className="word-count" role="button" tabIndex={0} title="Word count"
              onClick={() => setWordCountOpen(true)} onKeyDown={(e) => e.key === "Enter" && setWordCountOpen(true)}>
              {state?.words ?? 0} words
            </span>
          </div>
        </div>
      )}

      {findOpen && (
        <div className="ribbon" style={{ background: "#FBF9F7" }}>
          <input autoFocus placeholder="Find in document…" value={query}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && jump(1)}
            style={{ height: 30, border: "1px solid var(--line)", borderRadius: 9, padding: "0 10px", fontSize: 12, width: 220 }} />
          <label style={{ fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
            <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Aa
          </label>
          <span style={{ fontSize: 11, color: "#A19A95" }}>{matches.length} match{matches.length === 1 ? "" : "es"}</span>
          <button className="rb" onClick={() => jump(-1)}>↑</button>
          <button className="rb" onClick={() => jump(1)}>↓</button>
          {canEdit && (
            <>
              <div className="rb-sep" />
              <input placeholder="Replace with…" value={replace} onChange={(e) => setReplace(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && replaceCurrent(false)}
                style={{ height: 30, border: "1px solid var(--line)", borderRadius: 9, padding: "0 10px", fontSize: 12, width: 180 }} />
              <button className="rb" style={{ width: "auto", padding: "0 10px", fontSize: 11 }} onClick={() => replaceCurrent(false)}>Replace</button>
              <button className="rb" style={{ width: "auto", padding: "0 10px", fontSize: 11 }} onClick={() => replaceCurrent(true)}>All</button>
            </>
          )}
          <button className="rb" style={{ marginLeft: "auto" }} onClick={() => setFindOpen(false)}>✕</button>
        </div>
      )}

      <div className="doc-canvas" style={{ marginRight: panel !== "none" ? 330 : 0, marginLeft: panel === "outline" ? 240 : 0 }}>
        {panel === "outline" && (
          <div className="outline-pane">
            <div className="outline-head">Outline</div>
            {outline.length === 0 && <div className="outline-empty">Headings you add will appear here</div>}
            {outline.map((h, i) => (
              <button key={i} className="outline-item" style={{ paddingLeft: 8 + h.level * 12 }}
                onClick={() => jumpTo(h.pos)}>{h.text}</button>
            ))}
          </div>
        )}
        <div className="doc-zoom" style={{ zoom: zoom / 100 }}>
          {editor && <Ruler editor={editor} />}
          <div className="doc-page">
            <EditorContent editor={editor} />
          </div>
        </div>
      </div>

      {panel === "comments" && (
        <CommentsPanel fileId={item.id} comments={comments}
          canComment={canEdit || permission === "commenter" || permission === "reviewer"}
          onReload={loadComments} onAnchorClick={focusAnchor}
          onNewComment={submitComment} newCommentOpen={newComment}
          onCancelNew={() => { setNewComment(false); setPanel("none"); }}
          toast={toast} />
      )}
      {panel === "versions" && (
        <VersionsPanel item={item} onClose={() => setPanel("none")}
          onRestore={async () => {
            const r = await api.get<{ content: { doc: object } }>(`/api/files/${item.id}/content`);
            editor?.commands.setContent(r.content.doc);
          }} toast={toast} />
      )}
      {panel === "ai" && (
        <AiPanel fileId={item.id} kind="writer" canEdit={canEdit}
          serialize={() => (editor?.getText() ?? "").slice(0, 24000)}
          selection={() => {
            const { from, to } = editor?.state.selection ?? { from: 0, to: 0 };
            return to > from && editor ? editor.state.doc.textBetween(from, to, " ") : "";
          }}
          applyOps={aiApplyOps} onClose={() => setPanel("none")} toast={toast} />
      )}
      {panel === "suggest" && editor && (
        <SuggestionsPanel editor={editor} onClose={() => setPanel("none")} />
      )}
      {sharing && <ShareDialog item={item} onClose={() => setSharing(false)} toast={toast} />}
      {editor && <LinkPopover editor={editor} />}
      {specialChars && editor && <SpecialChars editor={editor} onClose={() => setSpecialChars(false)} />}
      {pageSetupOpen && editor && (
        <PageSetupDialog editor={editor} onClose={() => { setPageSetupOpen(false); savePageSetup(); }} />
      )}
      {wordCountOpen && (
        <div className="modal-overlay" onClick={() => setWordCountOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Word count">
            <h3>Word count</h3>
            <table className="kv-table"><tbody>
              <tr><td>Words</td><td>{state?.words ?? 0}</td></tr>
              <tr><td>Characters</td><td>{state?.chars ?? 0}</td></tr>
            </tbody></table>
            <button className="btn-primary btn-sm" onClick={() => setWordCountOpen(false)}>Close</button>
          </div>
        </div>
      )}
      {shortcutsOpen && (
        <div className="modal-overlay" onClick={() => setShortcutsOpen(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
            <h3>Keyboard shortcuts</h3>
            <table className="kv-table"><tbody>
              {[
                ["Bold", "Ctrl+B"], ["Italic", "Ctrl+I"], ["Underline", "Ctrl+U"],
                ["Insert link", "Ctrl+K"], ["Find", "Ctrl+F"], ["Find & replace", "Ctrl+H"],
                ["Page break", "Ctrl+Enter"], ["Undo", "Ctrl+Z"], ["Redo", "Ctrl+Y"],
                ["Clear formatting", "Ctrl+\\"], ["Save", "Ctrl+S"], ["Print / PDF", "Ctrl+P"],
              ].map(([label, k]) => <tr key={label}><td>{label}</td><td><kbd>{k}</kbd></td></tr>)}
            </tbody></table>
            <button className="btn-primary btn-sm" onClick={() => setShortcutsOpen(false)}>Close</button>
          </div>
        </div>
      )}
      <input ref={importRef} type="file" accept=".docx" hidden onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
      <input ref={textImportRef} type="file" accept=".md,.txt,.html,.htm" hidden onChange={(e) => e.target.files?.[0] && onTextImport(e.target.files[0])} />
      <input ref={imageRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onImage(e.target.files[0])} />
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}
