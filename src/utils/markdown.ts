import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

const parser = unified().use(remarkParse).use(remarkGfm);

const formattingNodeTypes = new Set<Nodes["type"]>([
  "blockquote",
  "break",
  "code",
  "definition",
  "delete",
  "emphasis",
  "footnoteDefinition",
  "footnoteReference",
  "heading",
  "image",
  "imageReference",
  "inlineCode",
  "link",
  "linkReference",
  "list",
  "strong",
  "table",
  "thematicBreak",
]);

function containsFormatting(node: Nodes): boolean {
  if (formattingNodeTypes.has(node.type)) return true;
  return "children" in node && node.children.some(containsFormatting);
}

function previewNodeText(node: Nodes): string {
  if (node.type === "image" || node.type === "imageReference")
    return `[Image: ${node.alt || "unnamed"}]`;
  if (node.type === "definition" || node.type === "footnoteDefinition") return "";
  if ("value" in node) return node.value;
  if ("children" in node)
    return node.children
      .map(previewNodeText)
      .join(
        ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(node.type)
          ? "\n"
          : "",
      );
  return "";
}

/** Bounded readable excerpt without mounting links, media or artifact embeds. */
export function markdownTextPreview(source: string, maximum = 400): string {
  return previewNodeText(parser.parse(source)).trim().slice(0, maximum);
}

/** Returns whether CommonMark/GFM parsing finds formatting that changes presentation. */
export function shouldRenderMarkdown(source: string): boolean {
  return containsFormatting(parser.parse(source));
}
