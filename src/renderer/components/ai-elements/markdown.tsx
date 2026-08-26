import { useMemo } from "react";
import type { ComponentProps } from "react";
import { math } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import {
  parseMarkdownIntoBlocks,
  Streamdown,
  type Components,
  type StreamdownProps,
} from "streamdown";
import { syntaxHighlighter } from "@/lib/syntax-highlighter";
import { cn } from "@/lib/utils";
import type { SourceLocation } from "../../../ipc/source-location";
import { formatSourceLocation, parseSourceLocation } from "../../../utils/source-location";

/** Matches web-style hrefs that must never be treated as workspace file paths. */
const nonPathHref = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const workspacePathPrefix = "/__cake_workspace__/";
const protectedMarkdown = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!?\[[^\]]*\]\([^)]+\))/g;
const bareSourceReference =
  /(^|[\s(])((?:[^\s/:#()[\],]+\/)*[^\s/:#()[\],]+\.[a-z][a-z0-9._+-]*(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?)(?=$|[\s),.;!?])/gi;

type AnchorProps = ComponentProps<"a"> & { node?: unknown };

function sourceHref(reference: string) {
  return `${workspacePathPrefix}${reference}`;
}

/** Makes explicit and bare workspace source references parseable and clickable. */
function prepareWorkspaceMarkdown(markdown: string) {
  return markdown
    .split(protectedMarkdown)
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment.replace(/\]\(([^)\s]+)\)$/, (match, target: string) =>
          parseSourceLocation(target) ? `](${sourceHref(target)})` : match,
        );
      }
      return segment.replace(bareSourceReference, (match, prefix: string, reference: string) =>
        parseSourceLocation(reference)
          ? `${prefix}[${reference}](${sourceHref(reference)})`
          : match,
      );
    })
    .join("");
}

function externalAnchor(allProps: AnchorProps) {
  const props = { ...allProps };
  delete props.node;
  return <a {...props} target="_blank" rel="noreferrer" />;
}

const mermaid = createMermaidPlugin({ config: { securityLevel: "strict" } });
const plugins = { code: syntaxHighlighter, math, mermaid };
const pluginsWithoutCode = { math, mermaid };

type MarkdownProps = Omit<
  StreamdownProps,
  | "children"
  | "components"
  | "isAnimating"
  | "mode"
  | "parseMarkdownIntoBlocksFn"
  | "plugins"
  | "skipHtml"
> & {
  children: string;
  /** Defers expensive highlighting while content is still changing. */
  highlightCode?: boolean;
  /** Invoked when the reader selects a workspace source reference. */
  onOpenSourceLocation?(location: SourceLocation): void;
};

export function Markdown({
  children,
  className,
  highlightCode = true,
  onOpenSourceLocation,
  ...props
}: MarkdownProps) {
  const source = onOpenSourceLocation ? prepareWorkspaceMarkdown(children) : children;
  const components = useMemo<Components>(() => {
    if (!onOpenSourceLocation) return { a: externalAnchor };
    const openSourceLocation = onOpenSourceLocation;
    return {
      a(allProps: AnchorProps) {
        const href = allProps.href;
        if (!href) return externalAnchor(allProps);
        const reference = href.startsWith(workspacePathPrefix)
          ? href.slice(workspacePathPrefix.length)
          : href.startsWith("./")
            ? href.slice(2)
            : href;
        const location = parseSourceLocation(reference);
        if (!location || (nonPathHref.test(href) && !href.startsWith(workspacePathPrefix)))
          return externalAnchor(allProps);
        const label = formatSourceLocation(location);
        const props = { ...allProps, href: reference };
        delete props.node;
        return (
          <a
            {...props}
            title={`Open ${label} in VS Code`}
            onClick={(event) => {
              event.preventDefault();
              openSourceLocation(location);
            }}
          />
        );
      },
    };
  }, [onOpenSourceLocation]);
  return (
    <Streamdown
      {...props}
      components={components}
      className={cn(
        "markdown-content min-w-0 max-w-full break-words [overflow-wrap:anywhere] [&_[data-streamdown=code-block-body]]:overflow-x-hidden [&_[data-streamdown=code-block-body]_pre]:whitespace-pre-wrap [&_[data-streamdown=code-block-body]_pre]:[overflow-wrap:anywhere]",
        className,
      )}
      controls={{
        code: {
          copy: true,
          download: false,
        },
      }}
      isAnimating={false}
      mode="static"
      parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocks}
      plugins={highlightCode ? plugins : pluginsWithoutCode}
      skipHtml
    >
      {source}
    </Streamdown>
  );
}

export function fencedCode(source: string, language: string) {
  const longestFence = Math.max(
    0,
    ...Array.from(source.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestFence + 1));
  return `${fence}${language}\n${source}\n${fence}`;
}
