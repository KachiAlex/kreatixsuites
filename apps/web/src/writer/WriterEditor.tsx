import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { EditorContent, useEditor, useEditorState } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TextStyle, Color, FontFamily } from "@tiptap/extension-text-style";
import { Highlight } from "@tiptap/extension-highlight";
import { TextAlign } from "@tiptap/extension-text-align";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Image } from "@tiptap/extension-image";
import { CharacterCount } from "@tiptap/extensions";
import { TextSelection } from "@tiptap/pm/state";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import * as Y from "yjs";
import { prosemirrorJSONToYDoc } from "y-prosemirror";
import type { Comment, DriveItem } from "@kreatix/shared";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { createCollabSession, type CollabSession } from "../collab/session";
import { PresenceBar } from "../collab/PresenceBar";
import { AiPanel, type AiOp } from "../ai/AiPanel";
import { CommentMark } from "./extensions";
import { exportDocx, importDocx } from "./docx";
import { ShareDialog } from "../components/ShareDialog";
import { VersionsPanel } from "../components/VersionsPanel";
import { CommentsPanel } from "../components/CommentsPanel";
import { useToast } from "../pages/Home";

type SaveState = "saved" | "saving" | "unsaved" | "error";

export function WriterEditor({ item, initialDoc, permission }: {
  item: DriveItem;
  initialDoc: unknown;
  permission: string;
}) {
  const navigate = useNavigate();
  const canEdit = permission === "owner" || permission === "editor";
  const { msg, toast } = useToast();
  const [title, setTitle] = useState(item.name);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [panel, setPanel] = useState<"none" | "comments" | "versions" | "ai">("none");
  const [sharing, setSharing] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [newComment, setNewComment] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const pendingJson = useRef<unknown>(null);

  // collab session — created synchronously so useEditor can bind the Y.Doc
  const { user } = useAuth();
  const sessionRef = useRef<CollabSession | null>(null);
  if (user && !sessionRef.current) sessionRef.current = createCollabSession(item.id, user);
  const session = sessionRef.current;
  useEffect(() => () => { sessionRef.current?.destroy(); sessionRef.current = null; }, []);

  const editor = useEditor({
    editable: canEdit,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TextStyle, Color, FontFamily,
      Highlight.configure({ multicolor: false }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Table.configure({ resizable: true }), TableRow, TableHeader, TableCell,
      Image,
      CharacterCount,
      CommentMark,
      ...(session ? [
        Collaboration.configure({ document: session.ydoc, field: "default" }),
        CollaborationCaret.configure({ provider: session.provider, user: { ...session.user } }),
      ] : []),
    ],
    // collab mode: content is driven by the shared Y.Doc (seeded after sync)
    content: session ? undefined : ((initialDoc as { doc?: object })?.doc ?? (initialDoc as object)),
    onUpdate: ({ editor }) => {
      pendingJson.current = { kind: "writer", doc: editor.getJSON() };
      setSaveState("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(flushSave, 1200);
    },
    editorProps: {
      attributes: { "aria-label": "Document editor" },
    },
  });

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
    try {
      await api.put(`/api/files/${item.id}/content${session ? "?collab=1" : ""}`, { content: payload });
      setSaveState("saved");
    } catch {
      setSaveState("error");
      toast("Could not save — will retry on next edit");
    }
  }, [item.id, session, toast]);

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
      canUndo: ctx.editor?.can().undo() ?? false,
      canRedo: ctx.editor?.can().redo() ?? false,
      bold: ctx.editor?.isActive("bold") ?? false,
      italic: ctx.editor?.isActive("italic") ?? false,
      underline: ctx.editor?.isActive("underline") ?? false,
      strike: ctx.editor?.isActive("strike") ?? false,
      highlight: ctx.editor?.isActive("highlight") ?? false,
      bullet: ctx.editor?.isActive("bulletList") ?? false,
      ordered: ctx.editor?.isActive("orderedList") ?? false,
      quote: ctx.editor?.isActive("blockquote") ?? false,
      block: ctx.editor?.isActive("heading", { level: 1 }) ? "h1"
        : ctx.editor?.isActive("heading", { level: 2 }) ? "h2"
        : ctx.editor?.isActive("heading", { level: 3 }) ? "h3"
        : ctx.editor?.isActive("blockquote") ? "quote" : "p",
      align: ctx.editor?.isActive({ textAlign: "center" }) ? "center"
        : ctx.editor?.isActive({ textAlign: "right" }) ? "right"
        : ctx.editor?.isActive({ textAlign: "justify" }) ? "justify" : "left",
      font: (ctx.editor?.getAttributes("textStyle").fontFamily as string) ?? "",
      color: (ctx.editor?.getAttributes("textStyle").color as string) ?? "",
    }),
  });

  // ---- find & replace (KBS-WRITER-017) ----
  const matches = useMemo(() => {
    if (!editor || !query) return [] as { from: number; to: number }[];
    const out: { from: number; to: number }[] = [];
    const needle = query.toLowerCase();
    editor.state.doc.descendants((node, pos) => {
      if (!node.isText || !node.text) return;
      let i = node.text.toLowerCase().indexOf(needle);
      while (i !== -1) {
        out.push({ from: pos + i, to: pos + i + needle.length });
        i = node.text.toLowerCase().indexOf(needle, i + 1);
      }
    });
    return out;
  }, [editor, query, state]);

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
      if (editor.state.doc.textBetween(from, to).toLowerCase() === query.toLowerCase()) {
        editor.chain().focus().insertContentAt({ from, to }, replace).run();
      }
      jump(1);
    }
  }, [editor, matches, query, replace, canEdit, jump, toast]);

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
          if (!node.isText || !node.text) return;
          let i = node.text.indexOf(needle);
          while (i !== -1) {
            matches.push({ from: pos + i, to: pos + i + needle.length });
            if (!o.all) return;
            i = node.text.indexOf(needle, i + 1);
          }
        });
        const use = o.all ? matches : matches.slice(0, 1);
        editor.chain().focus().command(({ tr }) => {
          [...use].reverse().forEach((m) => tr.insertText(String(o.replace ?? ""), m.from, m.to));
          return true;
        }).run();
      } else if (o.op === "append_paragraph" || o.op === "insert_heading") {
        editor.chain().focus().insertContentAt(editor.state.doc.nodeSize - 2,
          o.op === "insert_heading"
            ? { type: "heading", attrs: { level: o.level }, content: [{ type: "text", text: String(o.text) }] }
            : { type: "paragraph", content: [{ type: "text", text: String(o.text) }] }).run();
      } else if (o.op === "prepend_paragraph") {
        editor.chain().focus().insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: String(o.text) }] }).run();
      }
    }
  }, [editor]);

  // ---- docx import/export (KBS-WRITER-001) ----
  const onImport = async (f: File) => {
    try {
      const html = await importDocx(f);
      editor?.commands.setContent(html);
      toast(`Imported ${f.name}`);
    } catch {
      toast("Could not import that file");
    }
  };

  const onImage = async (f: File) => {
    const url = await new Promise<string>((res) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.readAsDataURL(f);
    });
    editor?.chain().focus().setImage({ src: url }).run();
  };

  const setBlock = (v: string) => {
    const c = editor?.chain().focus();
    if (!c) return;
    if (v === "p") c.setParagraph().run();
    else if (v === "quote") c.toggleBlockquote().run();
    else c.toggleHeading({ level: Number(v[1]) as 1 | 2 | 3 }).run();
  };

  const insertLink = () => {
    const url = prompt("Link URL:");
    if (url) editor?.chain().focus().setLink({ href: url }).run();
  };

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
        <button className="btn-ghost btn-sm" onClick={() => { setFindOpen((v) => !v); setQuery(""); }}>Find</button>
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "comments" ? "none" : "comments")}>
          Comments{comments.length ? ` (${comments.length})` : ""}
        </button>
        <button className="btn-ghost btn-sm" onClick={() => setPanel(panel === "versions" ? "none" : "versions")}>History</button>
        <button className="btn-ghost btn-sm" title="Kreatix AI" onClick={() => setPanel(panel === "ai" ? "none" : "ai")}>✨ AI</button>
        <button className="btn-ghost btn-sm" onClick={() => setSharing(true)}>Share</button>
        <button className="btn-primary btn-sm" onClick={() => exportDocx(editor?.getJSON() as never, title)}>Export .docx</button>
      </div>

      {canEdit && (
        <div className="ribbon">
          <button className="rb" title="Undo" disabled={!state?.canUndo} onClick={() => editor?.chain().focus().undo().run()}>↶</button>
          <button className="rb" title="Redo" disabled={!state?.canRedo} onClick={() => editor?.chain().focus().redo().run()}>↷</button>
          <div className="rb-sep" />
          <select className="rb-sel" value={state?.block ?? "p"} onChange={(e) => setBlock(e.target.value)} title="Style">
            <option value="p">Normal</option><option value="h1">Heading 1</option>
            <option value="h2">Heading 2</option><option value="h3">Heading 3</option>
            <option value="quote">Quote</option>
          </select>
          <select className="rb-sel" value={state?.font || ""} onChange={(e) =>
            e.target.value ? editor?.chain().focus().setFontFamily(e.target.value).run()
              : editor?.chain().focus().unsetFontFamily().run()} title="Font">
            <option value="">Inter</option><option value="Georgia">Georgia</option>
            <option value="Arial">Arial</option><option value="Times New Roman">Times</option>
            <option value="Consolas">Consolas</option>
          </select>
          <div className="rb-sep" />
          <button className={`rb ${state?.bold ? "on" : ""}`} title="Bold" onClick={() => editor?.chain().focus().toggleBold().run()}><b>B</b></button>
          <button className={`rb ${state?.italic ? "on" : ""}`} title="Italic" onClick={() => editor?.chain().focus().toggleItalic().run()}><i>I</i></button>
          <button className={`rb ${state?.underline ? "on" : ""}`} title="Underline" onClick={() => editor?.chain().focus().toggleUnderline().run()}><u>U</u></button>
          <button className={`rb ${state?.strike ? "on" : ""}`} title="Strikethrough" onClick={() => editor?.chain().focus().toggleStrike().run()}><s>S</s></button>
          <button className={`rb ${state?.highlight ? "on" : ""}`} title="Highlight" onClick={() => editor?.chain().focus().toggleHighlight().run()}>▨</button>
          <input type="color" className="rb" style={{ padding: 4 }} title="Text color" value={state?.color || "#171717"}
            onChange={(e) => editor?.chain().focus().setColor(e.target.value).run()} />
          <div className="rb-sep" />
          {(["left", "center", "right", "justify"] as const).map((a) => (
            <button key={a} className={`rb ${state?.align === a ? "on" : ""}`} title={`Align ${a}`}
              onClick={() => editor?.chain().focus().setTextAlign(a).run()}>
              {a === "left" ? "⇤" : a === "center" ? "≡" : a === "right" ? "⇥" : "☰"}
            </button>
          ))}
          <div className="rb-sep" />
          <button className={`rb ${state?.bullet ? "on" : ""}`} title="Bullet list" onClick={() => editor?.chain().focus().toggleBulletList().run()}>•≡</button>
          <button className={`rb ${state?.ordered ? "on" : ""}`} title="Numbered list" onClick={() => editor?.chain().focus().toggleOrderedList().run()}>1≡</button>
          <button className="rb" title="Link" onClick={insertLink}>🔗</button>
          <button className="rb" title="Insert table" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>⊞</button>
          <button className="rb" title="Insert image" onClick={() => imageRef.current?.click()}>🖼</button>
          <button className="rb" title="Horizontal rule" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>―</button>
          <button className="rb" title="Clear formatting" onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().run()}>⌫</button>
          <div className="rb-sep" />
          <button className="rb" title="Add comment" onClick={startComment}>💬</button>
          <button className="rb" title="Import .docx" onClick={() => importRef.current?.click()}>⇪</button>
          <input ref={importRef} type="file" accept=".docx" hidden onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])} />
          <input ref={imageRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && onImage(e.target.files[0])} />
          <span style={{ marginLeft: "auto", fontSize: 10, color: "#A19A95" }}>
            {state?.words ?? 0} words
          </span>
        </div>
      )}

      {findOpen && (
        <div className="ribbon" style={{ background: "#FBF9F7" }}>
          <input autoFocus placeholder="Find in document…" value={query}
            onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && jump(1)}
            style={{ height: 30, border: "1px solid var(--line)", borderRadius: 9, padding: "0 10px", fontSize: 12, width: 220 }} />
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

      <div className="doc-canvas" style={{ marginRight: panel !== "none" ? 330 : 0 }}>
        <div className="doc-page">
          <EditorContent editor={editor} />
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
      {sharing && <ShareDialog item={item} onClose={() => setSharing(false)} toast={toast} />}
      {msg && <div className="toast">{msg}</div>}
    </div>
  );
}
