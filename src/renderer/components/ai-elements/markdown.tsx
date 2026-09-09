import { createContext, useContext, useDeferredValue, useMemo } from "react";
import type { ComponentProps, ReactNode } from "react";
import type { Code, Root, RootContent } from "mdast";
import { math } from "@streamdown/math";
import { createMermaidPlugin } from "@streamdown/mermaid";
import remarkParse from "remark-parse";
import {
  parseMarkdownIntoBlocks,
  Streamdown,
  type Components,
  type StreamdownProps,
} from "streamdown";
import { unified } from "unified";
import { useResolvedColorTheme } from "@/lib/resolved-color-theme";
import {
  supportsSyntaxHighlightLanguage,
  syntaxHighlighter,
  syntaxHighlightLanguageNames,
} from "@/lib/syntax-highlighter";
import { cn } from "@/lib/utils";
import type { SourceLocation } from "../../../ipc/source-location";
import { formatSourceLocation, parseSourceLocation } from "../../../utils/source-location";
import { MarkdownCodeBlock, streamingCodeMarker } from "./markdown-code-block";

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
const configuredPlugins = {
  code: syntaxHighlighter,
  math,
  mermaid,
  renderers: [
    {
      component: MarkdownCodeBlock,
      language: syntaxHighlightLanguageNames,
    },
  ],
};
const codeControls = {
  code: {
    copy: true,
    download: false,
  },
};

type FenceLocation = {
  contentStart: number;
  incomplete: boolean;
  languageEnd: number;
  languageStart: number;
  linePrefix: string;
  normalizedLanguage: string;
  openingInfoEnd: number;
};

const markdownParser = unified().use(remarkParse);
const closingFenceLine = /^(?:(?: {0,3}>[ \t]?)*[ \t]*)(`+|~+)[ \t]*$/;
const listMarkerAtEnd = /(?:[-+*]|\d+[.)])[ \t]+$/;

function finalCodeNode(markdown: string) {
  let finalCode: Code | undefined;
  const visit = (node: Root | RootContent) => {
    if (node.type === "code") finalCode = node;
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(markdownParser.parse(markdown));
  return finalCode;
}

function lastFence(markdown: string): FenceLocation | undefined {
  const code = finalCodeNode(markdown);
  const openingStart = code?.position?.start?.offset;
  const codeEnd = code?.position?.end?.offset;
  const language = code?.lang;
  if (
    openingStart === undefined ||
    codeEnd === undefined ||
    !language ||
    !supportsSyntaxHighlightLanguage(language)
  )
    return undefined;

  const openingLineBreak = markdown.indexOf("\n", openingStart);
  const contentStart = openingLineBreak < 0 ? markdown.length : openingLineBreak + 1;
  const openingInfoEnd =
    openingLineBreak < 0
      ? markdown.length
      : markdown[openingLineBreak - 1] === "\r"
        ? openingLineBreak - 1
        : openingLineBreak;
  const openingLine = markdown.slice(openingStart, openingInfoEnd);
  const opening = openingLine.match(/^(`{3,}|~{3,})/)?.[1];
  if (!opening) return undefined;
  const relativeLanguageStart = openingLine.indexOf(language, opening.length);
  if (relativeLanguageStart < 0) return undefined;

  const rawCode = markdown.slice(openingStart, codeEnd);
  const finalLine = rawCode.slice(rawCode.lastIndexOf("\n") + 1);
  const closing = finalLine.match(closingFenceLine)?.[1];
  const hasClosingFence =
    closing !== undefined && closing[0] === opening[0] && closing.length >= opening.length;
  const endsAtStreamingEdge = /^(?:\r?\n)?$/.test(markdown.slice(codeEnd));
  const incomplete = !hasClosingFence && endsAtStreamingEdge;
  const openingLineStart = markdown.lastIndexOf("\n", openingStart - 1) + 1;
  const openingPrefix = markdown.slice(openingLineStart, openingStart);
  const linePrefix = openingPrefix.replace(listMarkerAtEnd, (marker) => " ".repeat(marker.length));
  const languageStart = openingStart + relativeLanguageStart;
  return {
    contentStart,
    incomplete,
    languageEnd: languageStart + language.length,
    languageStart,
    linePrefix,
    normalizedLanguage: language.toLowerCase(),
    openingInfoEnd,
  };
}

function markChangingFence(markdown: string, mutableCode: boolean) {
  const finalFence = lastFence(markdown);
  if (!finalFence || (!mutableCode && !finalFence.incomplete)) return markdown;
  const markedOpening = `${markdown.slice(0, finalFence.languageStart)}${finalFence.normalizedLanguage}${markdown.slice(finalFence.languageEnd, finalFence.openingInfoEnd)} ${streamingCodeMarker}${markdown.slice(finalFence.openingInfoEnd, finalFence.contentStart)}`;
  if (finalFence.contentStart === finalFence.openingInfoEnd) return markedOpening;
  return `${markedOpening}${finalFence.linePrefix}${streamingCodeMarker}\n${markdown.slice(finalFence.contentStart)}`;
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
  const mermaidOptions = useMemo<NonNullable<StreamdownProps["mermaid"]>>(
    () => ({
      config: {
        securityLevel: "strict",
        theme: colorTheme === "dark" ? "dark" : "neutral",
      },
    }),
    [colorTheme],
  );
  const source = prepareMarkdownLinks(
    normalizeLatexDelimiters ? normalizeLatexMathDelimiters(children) : children,
    Boolean(onOpenSourceLocation),
  );
  // Streaming updates are lower priority than scrolling and other input. Keeping
  // Streamdown on its previous source during the urgent render also lets React
  // coalesce token-sized updates before parsing the growing Markdown again.
  const deferredSource = useDeferredValue(source);
  const deferredRenderedSource = streaming ? deferredSource : source;
  // Mark the one logical fence that is still changing. The custom code renderer
  // reads fence metadata, so duplicate source text in settled blocks cannot be
  // mistaken for the active block and the shared highlighter remains stable.
  const renderedSource = streaming
    ? markChangingFence(deferredRenderedSource, mutableCode)
    : deferredRenderedSource;
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
      controls={codeControls}
      isAnimating={false}
      mermaid={mermaidOptions}
      mode="streaming"
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
