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

/** Returns whether CommonMark/GFM parsing finds formatting that changes presentation. */
export function shouldRenderMarkdown(source: string): boolean {
  return containsFormatting(parser.parse(source));
}
