import { useMemo } from "react";
import type { ComponentProps } from "react";
import { createCodePlugin } from "@streamdown/code";
import { math } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import {
  parseMarkdownIntoBlocks,
  Streamdown,
  type Components,
  type StreamdownProps,
} from "streamdown";
import { cn } from "@/lib/utils";

/** Matches web-style hrefs that must never be treated as workspace file paths. */
const nonPathHref = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const workspacePathPrefix = "/__cake_workspace__/";

type AnchorProps = ComponentProps<"a"> & { node?: unknown };

/** Makes bare workspace paths parseable by Streamdown's hardened link policy. */
function prepareWorkspaceMarkdown(markdown: string) {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (match, target: string) => {
    if (
      nonPathHref.test(target) ||
      target.startsWith("/") ||
      target.startsWith("./") ||
      target.startsWith("../")
    )
      return match;
    return `](${workspacePathPrefix}${target})`;
  });
}

function externalAnchor(allProps: AnchorProps) {
  const props = { ...allProps };
  delete props.node;
  return <a {...props} target="_blank" rel="noreferrer" />;
}

const mermaid = createMermaidPlugin({ config: { securityLevel: "strict" } });
// Use a high-contrast light theme; the default github-light renders punctuation
// and other neutral tokens too faintly in light mode.
const code = createCodePlugin({ themes: ["github-light-high-contrast", "github-dark"] });
const plugins = { code, math, mermaid };

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
  /** Invoked when the reader clicks a link whose target is a file path instead of a web URL. */
  onOpenFilePath?(path: string): void;
};

export function Markdown({ children, className, onOpenFilePath, ...props }: MarkdownProps) {
  const source = onOpenFilePath ? prepareWorkspaceMarkdown(children) : children;
  const components = useMemo<Components>(() => {
    if (!onOpenFilePath) return { a: externalAnchor };
    const openFilePath = onOpenFilePath;
    return {
      a(allProps: AnchorProps) {
        const href = allProps.href;
        if (!href || nonPathHref.test(href)) return externalAnchor(allProps);
        const workspaceHref = href.startsWith(workspacePathPrefix)
          ? href.slice(workspacePathPrefix.length)
          : href.startsWith("./")
            ? href.slice(2)
            : href;
        const props = { ...allProps, href: workspaceHref };
        delete props.node;
        return (
          <a
            {...props}
            title={`Open ${workspaceHref} in Browse`}
            onClick={(event) => {
              event.preventDefault();
              openFilePath(workspaceHref);
            }}
          />
        );
      },
    };
  }, [onOpenFilePath]);
  return (
    <Streamdown
      {...props}
      components={components}
      className={cn(
        "markdown-content min-w-0 max-w-full break-words [overflow-wrap:anywhere]",
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
      plugins={plugins}
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
