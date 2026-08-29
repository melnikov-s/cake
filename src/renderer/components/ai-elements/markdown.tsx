import { createContext, useContext, useMemo } from "react";
import type { ComponentProps, ReactNode } from "react";
import { math } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import {
  parseMarkdownIntoBlocks,
  Streamdown,
  type Components,
  type StreamdownProps,
} from "streamdown";
import { useResolvedColorTheme } from "@/lib/resolved-color-theme";
import { syntaxHighlighter } from "@/lib/syntax-highlighter";
import { cn } from "@/lib/utils";
import type { SourceLocation } from "../../../ipc/source-location";
import { formatSourceLocation, parseSourceLocation } from "../../../utils/source-location";

/** Matches web-style hrefs that must never be treated as workspace file paths. */
const nonPathHref = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const workspacePathPrefix = "/__cake_workspace__/";
const sessionPathPrefix = "/__cake_session__/";
const protectedMarkdown = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!?\[[^\]]*\]\([^)]+\))/g;
const bareSourceReference =
  /(^|[\s(])((?:[^\s/:#()[\],]+\/)*[^\s/:#()[\],]+\.[a-z][a-z0-9._+-]*(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?)?)(?=$|[\s),.;!?])/gi;

type AnchorProps = ComponentProps<"a"> & { node?: unknown };

type MarkdownLinkActions = {
  openExternalUrl(url: string): void;
  openSession(sessionId: string): void;
};

const MarkdownLinkContext = createContext<MarkdownLinkActions | undefined>(undefined);

export function MarkdownLinkProvider({
  actions,
  children,
}: {
  actions: MarkdownLinkActions;
  children: ReactNode;
}) {
  return <MarkdownLinkContext value={actions}>{children}</MarkdownLinkContext>;
}

function sessionIdFromHref(href: string) {
  try {
    const encodedId = href.startsWith(sessionPathPrefix)
      ? href.slice(sessionPathPrefix.length)
      : (() => {
          const url = new URL(href);
          return url.protocol === "cake:" && url.hostname === "session"
            ? url.pathname.slice(1)
            : undefined;
        })();
    return encodedId && !encodedId.includes("/") ? decodeURIComponent(encodedId) : undefined;
  } catch {
    return undefined;
  }
}

function sourceHref(reference: string) {
  return `${workspacePathPrefix}${reference}`;
}

/** Makes Cake session links and workspace source references parseable and clickable. */
function prepareMarkdownLinks(markdown: string, sourceLinks: boolean) {
  return markdown
    .split(protectedMarkdown)
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment.replace(/\]\(([^)\s]+)\)$/, (match, target: string) => {
          const sessionId = sessionIdFromHref(target);
          if (sessionId) return `](${sessionPathPrefix}${encodeURIComponent(sessionId)})`;
          return sourceLinks && parseSourceLocation(target) ? `](${sourceHref(target)})` : match;
        });
      }
      if (!sourceLinks) return segment;
      return segment.replace(bareSourceReference, (match, prefix: string, reference: string) =>
        parseSourceLocation(reference)
          ? `${prefix}[${reference}](${sourceHref(reference)})`
          : match,
      );
    })
    .join("");
}

function linkAnchor(allProps: AnchorProps, actions?: MarkdownLinkActions) {
  const props = { ...allProps };
  delete props.node;
  const href = props.href;
  const sessionId = href ? sessionIdFromHref(href) : undefined;
  if (sessionId) {
    return (
      <a
        {...props}
        className={cn("inline-block max-w-[80ch] truncate align-bottom", props.className)}
        onClick={(event) => {
          event.preventDefault();
          actions?.openSession(sessionId);
        }}
      />
    );
  }
  const external = href ? /^https?:\/\//i.test(href) : false;
  return (
    <a
      {...props}
      target="_blank"
      rel="noreferrer"
      onClick={
        external && actions
          ? (event) => {
              event.preventDefault();
              actions.openExternalUrl(href!);
            }
          : props.onClick
      }
    />
  );
}

const mermaid = createMermaidPlugin({ config: { securityLevel: "strict" } });
const plugins = {
  light: { code: syntaxHighlighter, math, mermaid },
  dark: { code: syntaxHighlighter, math, mermaid },
};
const pluginsWithoutCode = {
  light: { math, mermaid },
  dark: { math, mermaid },
};

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
  const colorTheme = useResolvedColorTheme();
  const linkActions = useContext(MarkdownLinkContext);
  const source = prepareMarkdownLinks(children, Boolean(onOpenSourceLocation));
  const components = useMemo<Components>(() => {
    if (!onOpenSourceLocation) return { a: (anchorProps) => linkAnchor(anchorProps, linkActions) };
    const openSourceLocation = onOpenSourceLocation;
    return {
      a(allProps: AnchorProps) {
        const href = allProps.href;
        if (!href) return linkAnchor(allProps, linkActions);
        const reference = href.startsWith(workspacePathPrefix)
          ? href.slice(workspacePathPrefix.length)
          : href.startsWith("./")
            ? href.slice(2)
            : href;
        const location = parseSourceLocation(reference);
        if (!location || (nonPathHref.test(href) && !href.startsWith(workspacePathPrefix)))
          return linkAnchor(allProps, linkActions);
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
  }, [linkActions, onOpenSourceLocation]);
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
      mermaid={{
        config: { securityLevel: "strict", theme: colorTheme === "dark" ? "dark" : "neutral" },
      }}
      mode="static"
      parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocks}
      plugins={highlightCode ? plugins[colorTheme] : pluginsWithoutCode[colorTheme]}
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
