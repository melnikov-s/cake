import type { RootContent } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";
import type { UiPart } from "../../contracts/conversations/session-contract";
import type { ArtifactStableRef } from "../../contracts/artifacts/artifact-lineage";

const parser = unified().use(remarkParse);
const artifactReference = /^cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:@r[1-9][0-9]*)?$/;

/** Match the standalone-image rule in Markdown, not prose links or fenced examples.
 * Inspect the complete projected history, including rows outside the virtualized viewport. */
export function inlineArtifactReferences(parts: readonly UiPart[]): ArtifactStableRef[] {
  const references: ArtifactStableRef[] = [];
  // AssistantTextMessage suppresses stable embeds already owned by a publication.
  const published = new Set(
    parts.flatMap((part) =>
      part.kind === "tool" && part.artifactId ? [`cake://artifact/${part.artifactId}`] : [],
    ),
  );
  const visit = (node: RootContent, omitted: ReadonlySet<string>) => {
    if (node.type === "paragraph" && node.children.length === 1) {
      const image = node.children[0];
      if (image?.type === "image" && artifactReference.test(image.url) && !omitted.has(image.url))
        references.push(image.url);
    }
    if ("children" in node) for (const child of node.children) visit(child, omitted);
  };
  for (const part of parts) {
    if (part.kind === "tool" && part.artifactId) {
      references.push(
        part.artifactReference ??
          `cake://artifact/${part.artifactId}${part.artifactRevision ? `@r${part.artifactRevision}` : ""}`,
      );
    } else if (part.kind === "text" && part.text.includes("cake://artifact/")) {
      const omitted = part.role === "assistant" ? published : new Set<string>();
      for (const node of parser.parse(part.text).children) visit(node, omitted);
    }
  }
  return references;
}
