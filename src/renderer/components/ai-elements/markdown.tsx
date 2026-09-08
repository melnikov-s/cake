import { createContext, useContext, useDeferredValue, useMemo, useRef } from "react";
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
import { plainSyntaxHighlight, syntaxHighlighter } from "@/lib/syntax-highlighter";
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
function lastFence(markdown: string) {
  let fence: { marker: "`" | "~"; length: number; contentStart: number } | undefined;
  let latest: { code: string; incomplete: boolean } | undefined;
  let offset = 0;

  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*(?:\n|$)/)?.[1];
      if (closing?.[0] === fence.marker && closing.length >= fence.length) {
        latest = {
          code: markdown.slice(fence.contentStart, offset).replace(/\n+$/, ""),
          incomplete: false,
        };
        fence = undefined;
      }
    } else {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (
        opening &&
        (opening[0] === "~" || !line.slice(line.indexOf(opening) + opening.length).includes("`"))
      ) {
        fence = {
          marker: opening.startsWith("`") ? "`" : "~",
          length: opening.length,
          contentStart: offset + line.length,
        };
      }
    }
    offset += line.length;
  }

  return fence
    ? { code: markdown.slice(fence.contentStart).replace(/\n+$/, ""), incomplete: true }
    : latest;
}

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
  /** Keeps only the currently incomplete code fence plain while content streams. */
  streaming?: boolean;
  /** Marks the final fenced block itself as changing even when its fence is synthetically closed. */
  mutableCode?: boolean;
  /** Normalizes conventional LaTeX delimiters after streamed content settles. */
  normalizeLatexDelimiters?: boolean;
  /** Invoked when the reader selects a workspace source reference. */
  onOpenSourceLocation?(location: SourceLocation): void;
};

export function Markdown({
  children,
  className,
  streaming = false,
  mutableCode = false,
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
  // Streaming updates are lower priority than scrolling and other input. Keeping
  // Streamdown on its previous source during the urgent render also lets React
  // coalesce token-sized updates before parsing the growing Markdown again.
  const deferredSource = useDeferredValue(source);
  const renderedSource = streaming ? deferredSource : source;
  const finalFence = streaming ? lastFence(renderedSource) : undefined;
  const changingCode =
    finalFence && (mutableCode || finalFence.incomplete) ? finalFence.code : undefined;
  const changingCodeRef = useRef(changingCode);
  changingCodeRef.current = changingCode;
  const codeHighlighter = useMemo(
    () => ({
      ...syntaxHighlighter,
      highlight: (...args: Parameters<typeof syntaxHighlighter.highlight>) =>
        changingCodeRef.current === args[0].code
          ? plainSyntaxHighlight(args[0].code)
          : syntaxHighlighter.highlight(...args),
    }),
    [mutableCode, streaming],
  );
  const configuredPlugins = useMemo(
    () => ({ code: codeHighlighter, math, mermaid }),
    [codeHighlighter],
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
      plugins={configuredPlugins}
      skipHtml
    >
      {renderedSource}
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
