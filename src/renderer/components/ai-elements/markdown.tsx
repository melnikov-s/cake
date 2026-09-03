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

function normalizeLatexMathDelimiters(markdown: string) {
  const normalizeText = (text: string) =>
    text
      .replace(/\\\[([\s\S]*?)\\\]/g, (_match, body: string) => `$$${body}$$`)
      .replace(/\\\((.*?)\\\)/g, (_match, body: string) => `$${body}$`);
  let result = "";
  let text = "";
  let fence: { marker: "`" | "~"; length: number } | undefined;

  const flushText = () => {
    result += normalizeText(text);
    text = "";
  };

  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (fence) {
      flushText();
      result += line;
      const closingFence = line.match(/^ {0,3}(`+|~+)[ \t]*(?:\n|$)/)?.[1];
      if (closingFence?.[0] === fence.marker && closingFence.length >= fence.length)
        fence = undefined;
      continue;
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (
      openingFence &&
      (openingFence[0] === "~" ||
        !line.slice(line.indexOf(openingFence) + openingFence.length).includes("`"))
    ) {
      flushText();
      result += line;
      fence = {
        marker: openingFence.startsWith("`") ? "`" : "~",
        length: openingFence.length,
      };
      continue;
    }

    let cursor = 0;
    while (cursor < line.length) {
      const opening = line.indexOf("`", cursor);
      if (opening < 0) break;
      let openingEnd = opening + 1;
      while (line[openingEnd] === "`") openingEnd += 1;
      const delimiter = line.slice(opening, openingEnd);
      let closing = line.indexOf(delimiter, openingEnd);
      while (
        closing >= 0 &&
        (line[closing - 1] === "`" || line[closing + delimiter.length] === "`")
      )
        closing = line.indexOf(delimiter, closing + delimiter.length);
      if (closing < 0) break;

      text += line.slice(cursor, opening);
      flushText();
      const closingEnd = closing + delimiter.length;
      result += line.slice(opening, closingEnd);
      cursor = closingEnd;
    }
    text += line.slice(cursor);
  }

  flushText();
  return result;
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
  /** Normalizes conventional LaTeX delimiters after streamed content settles. */
  normalizeLatexDelimiters?: boolean;
  /** Invoked when the reader selects a workspace source reference. */
  onOpenSourceLocation?(location: SourceLocation): void;
};

export function Markdown({
  children,
  className,
  highlightCode = true,
  normalizeLatexDelimiters = true,
  onOpenSourceLocation,
  ...props
}: MarkdownProps) {
  const colorTheme = useResolvedColorTheme();
  const linkActions = useContext(MarkdownLinkContext);
  const source = prepareMarkdownLinks(
    normalizeLatexDelimiters ? normalizeLatexMathDelimiters(children) : children,
    Boolean(onOpenSourceLocation),
  );
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
