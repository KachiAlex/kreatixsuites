import { Node, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    embed: {
      /** Insert a sandboxed iframe embed (YouTube, Vimeo, generic URL). */
      insertEmbed: (src: string) => ReturnType;
    };
  }
}

const embedUrl = (src: string) => {
  const yt = src.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,})/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}`;
  const vm = src.match(/vimeo\.com\/(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return src;
};

/** Block embed node — renders a sandboxed iframe. */
export const Embed = Node.create({
  name: "embed",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      src: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-src") ?? "",
        renderHTML: (attrs) => ({ "data-src": attrs.src }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="embed"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { "data-type": "embed", class: "doc-embed" })];
  },

  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "doc-embed";
      dom.setAttribute("data-type", "embed");
      dom.contentEditable = "false";
      const frame = document.createElement("iframe");
      frame.src = embedUrl(node.attrs.src);
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation");
      frame.setAttribute("loading", "lazy");
      frame.allow = "fullscreen";
      dom.appendChild(frame);
      return { dom };
    };
  },

  addCommands() {
    return {
      insertEmbed:
        (src) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { src } }),
    };
  },
});
