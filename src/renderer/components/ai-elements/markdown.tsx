import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useDeferredValue,
  useMemo,
  useState,
} from "react";
import type { ComponentProps, MouseEvent, ReactNode } from "react";
import type { Code, Root, RootContent } from "mdast";
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
import { MermaidFullscreen } from "../mermaid-fullscreen";
import { MarkdownImage } from "../markdown-image";
import { MarkdownCodeBlock, streamingCodeMarker } from "./markdown-code-block";

/** Matches web-style hrefs that must never be treated as workspace file paths. */
const nonPathHref = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const workspacePathPrefix = "/__cake_workspace__/";
const sessionPathPrefix = "/__cake_session__/";
const artifactPathPrefix = "/__cake_artifact__/";
const protectedMarkdown = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!?\[[^\]]*\]\([^)]+\))/g;
const bareSourceReference =
  /(^|[\s(])((?:[^\s/:#()[\],]+\/)*[^\s/:#()[\],]+\.[a-z][a-z0-9._+-]*(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?(?:,L\d+(?:-L?\d+)?)*)?)(?=$|[\s),.;!?])/gi;
const bareArtifactReference =
  /(^|[\s(])(cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:@r[1-9][0-9]*)?)(?=$|[\s),.;!?])/g;

type AnchorProps = ComponentProps<"a"> & { node?: unknown };
type ImageProps = ComponentProps<"img"> & { node?: unknown };

type MarkdownLinkActions = {
  openExternalUrl(url: string): void;
  openSession(sessionId: string): void;
  loadWorkspaceImage?(
    path: string,
    signal: AbortSignal,
  ): Promise<{ readonly data: string; readonly mimeType: string }>;
  renderArtifactReference?(reference: string): ReactNode;
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

function workspaceImagePathFromSrc(src: string) {
  const reference = src.startsWith(workspacePathPrefix)
    ? src.slice(workspacePathPrefix.length)
    : src.startsWith("./")
      ? src.slice(2)
      : src;
  if (nonPathHref.test(reference)) return undefined;
  const location = parseSourceLocation(reference);
  return location && !location.range && !location.ranges && !location.view
    ? location.path
    : undefined;
}

function artifactReferenceFromHref(href: string) {
  try {
    if (href.startsWith(artifactPathPrefix)) {
      const reference = decodeURIComponent(href.slice(artifactPathPrefix.length));
      return /^cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:@r[1-9][0-9]*)?$/.test(reference)
        ? reference
        : undefined;
    }
    const url = new URL(href);
    if (url.protocol !== "cake:" || url.hostname !== "artifact") return undefined;
    const id = decodeURIComponent(url.pathname.slice(1));
    return /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:@r[1-9][0-9]*)?$/.test(id)
      ? `cake://artifact/${id}`
      : undefined;
  } catch {
    return undefined;
  }
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
          const artifactReference = artifactReferenceFromHref(target);
          if (artifactReference)
            return `](${artifactPathPrefix}${encodeURIComponent(artifactReference)})`;
          return sourceLinks && parseSourceLocation(target) ? `](${sourceHref(target)})` : match;
        });
      }
      const withArtifacts = segment.replace(
        bareArtifactReference,
        (_match, prefix: string, reference: string) =>
          `${prefix}[${reference}](${artifactPathPrefix}${encodeURIComponent(reference)})`,
      );
      if (!sourceLinks) return withArtifacts;
      return withArtifacts.replace(
        bareSourceReference,
        (match, prefix: string, reference: string) =>
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
  const artifactReference = href ? artifactReferenceFromHref(href) : undefined;
  if (artifactReference && actions?.renderArtifactReference)
    return actions.renderArtifactReference(artifactReference);
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

const configuredPlugins = {
  code: syntaxHighlighter,
  renderers: [
    {
      component: MarkdownCodeBlock,
      language: syntaxHighlightLanguageNames,
    },
  ],
};
const markdownControls = {
  code: {
    copy: true,
    download: false,
  },
  table: {
    copy: true,
    download: false,
    fullscreen: true,
  },
  mermaid: {
    copy: true,
    download: false,
    fullscreen: true,
    panZoom: false,
  },
};

const codeBlockPresentation =
  "[&_[data-streamdown=code-block]]:relative [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden [&_[data-streamdown=code-block-actions]]:!absolute [&_[data-streamdown=code-block-actions]]:!top-2 [&_[data-streamdown=code-block-actions]]:!right-2 [&_[data-streamdown=code-block-actions]]:!mt-0 [&_[data-streamdown=code-block-actions]]:!h-auto [&_[data-streamdown=code-block-actions]]:opacity-0 [&_[data-streamdown=code-block-actions]]:transition-opacity [&_[data-streamdown=code-block-actions]>div]:!border-0 [&_[data-streamdown=code-block-actions]>div]:!bg-transparent [&_[data-streamdown=code-block-actions]>div]:!p-0 [&_[data-streamdown=code-block-actions]>div]:!backdrop-blur-none [&_[data-streamdown=code-block]:hover_[data-streamdown=code-block-actions]]:opacity-100 [&_[data-streamdown=code-block]:focus-within_[data-streamdown=code-block-actions]]:opacity-100";

const richBlockPresentation =
  "[&_[data-streamdown=table-wrapper]]:relative [&_[data-streamdown=table-wrapper]]:border-0 [&_[data-streamdown=table-wrapper]]:bg-transparent [&_[data-streamdown=table-wrapper]]:p-0 [&_[data-streamdown=table-wrapper]>div:first-child>button]:opacity-0 [&_[data-streamdown=table-wrapper]>div:first-child>button]:transition-opacity [&_[data-streamdown=table-wrapper]:hover>div:first-child>button]:opacity-100 [&_[data-streamdown=table-wrapper]:focus-within>div:first-child>button]:opacity-100 [&_[data-streamdown=mermaid-block]]:border-0 [&_[data-streamdown=mermaid-block]]:bg-transparent [&_[data-streamdown=mermaid-block]]:p-0 [&_[data-streamdown=mermaid-block-actions]]:border-0 [&_[data-streamdown=mermaid-block-actions]]:bg-transparent [&_[data-streamdown=mermaid-block-actions]]:p-0 [&_[data-streamdown=mermaid-block-actions]]:backdrop-blur-none [&_[data-streamdown=mermaid-block-actions]>button:last-child]:opacity-0 [&_[data-streamdown=mermaid-block-actions]>button:last-child]:transition-opacity [&_[data-streamdown=mermaid-block]:hover_[data-streamdown=mermaid-block-actions]>button:last-child]:opacity-100 [&_[data-streamdown=mermaid-block]:focus-within_[data-streamdown=mermaid-block-actions]>button:last-child]:opacity-100";

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

export type MarkdownProps = Omit<
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

type RichMarkdownPlugins = Partial<
  Pick<NonNullable<StreamdownProps["plugins"]>, "math" | "mermaid">
>;

const MathMarkdown = lazy(async () => {
  const [{ math }] = await Promise.all([
    import("@streamdown/math"),
    import("katex/dist/katex.min.css"),
  ]);
  return {
    default: (props: MarkdownProps) => <MarkdownRenderer {...props} richPlugins={{ math }} />,
  };
});

const MermaidMarkdown = lazy(async () => {
  const { createMermaidPlugin } = await import("@streamdown/mermaid");
  const mermaid = createMermaidPlugin({ config: { securityLevel: "strict" } });
  return {
    default: (props: MarkdownProps) => <MarkdownRenderer {...props} richPlugins={{ mermaid }} />,
  };
});

const MathAndMermaidMarkdown = lazy(async () => {
  const [{ math }, { createMermaidPlugin }] = await Promise.all([
    import("@streamdown/math"),
    import("@streamdown/mermaid"),
    import("katex/dist/katex.min.css"),
  ]);
  const richPlugins: RichMarkdownPlugins = {
    math,
    mermaid: createMermaidPlugin({ config: { securityLevel: "strict" } }),
  };
  return {
    default: (props: MarkdownProps) => <MarkdownRenderer {...props} richPlugins={richPlugins} />,
  };
});

function richMarkdownFeatures(source: string, normalizeLatexDelimiters = true) {
  return {
    math: /\$\$/.test(source) || (normalizeLatexDelimiters && /\\\(|\\\[/.test(source)),
    mermaid: /(?:^|\n)[^\n]*(?:`{3,}|~{3,})\s*mermaid\b/i.test(source),
  };
}

export function Markdown(props: MarkdownProps) {
  // Streaming content defers LaTeX normalization until it settles, but plugin
  // selection must not change at that moment: swapping renderers would remount
  // the Markdown and dismiss an open Mermaid fullscreen view.
  const features = richMarkdownFeatures(
    props.children,
    props.streaming || props.normalizeLatexDelimiters !== false,
  );
  const RichMarkdown = features.math
    ? features.mermaid
      ? MathAndMermaidMarkdown
      : MathMarkdown
    : features.mermaid
      ? MermaidMarkdown
      : undefined;
  if (!RichMarkdown) return <MarkdownRenderer {...props} />;
  return (
    <Suspense fallback={<MarkdownRenderer {...props} />}>
      <RichMarkdown {...props} />
    </Suspense>
  );
}

function MarkdownRenderer({
  children,
  className,
  streaming = false,
  mutableCode = false,
  normalizeLatexDelimiters = true,
  onOpenSourceLocation,
  richPlugins,
  ...props
}: MarkdownProps & { richPlugins?: RichMarkdownPlugins }) {
  const colorTheme = useResolvedColorTheme();
  const linkActions = useContext(MarkdownLinkContext);
  const [fullscreenMermaid, setFullscreenMermaid] = useState<string>();
  const plugins = useMemo(
    () => (richPlugins ? { ...configuredPlugins, ...richPlugins } : configuredPlugins),
    [richPlugins],
  );
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
  const openMermaidFullscreen = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button[title="View fullscreen"]');
    const block = button?.closest<HTMLElement>('[data-streamdown="mermaid-block"]');
    // The block's action bar (with icon SVGs) precedes the chart, so select the
    // rendered diagram explicitly rather than the first SVG in the block.
    const svg = block?.querySelector<SVGSVGElement>(
      '[data-streamdown="mermaid"] [role="img"] > svg',
    );
    if (!button || !block || !svg) return;

    // Streamdown owns its fullscreen state inside the parsed Markdown block. A
    // block may be replaced when a stream settles, which used to dismiss an
    // open diagram without user input. Intercept that action and hoist the
    // rendered diagram above the parser lifecycle instead.
    event.preventDefault();
    event.stopPropagation();
    setFullscreenMermaid(svg.outerHTML);
  }, []);
  const components = useMemo<Components>(() => {
    const openSourceLocation = onOpenSourceLocation;
    return {
      a(allProps: AnchorProps) {
        if (!openSourceLocation) return linkAnchor(allProps, linkActions);
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
            className={cn(
              "underline decoration-dashed decoration-border underline-offset-4 hover:decoration-muted-foreground",
              props.className,
            )}
            title={`Open ${label} in VS Code`}
            onClick={(event) => {
              event.preventDefault();
              openSourceLocation(location);
            }}
          />
        );
      },
      img(allProps: ImageProps) {
        const props = { ...allProps };
        delete props.node;
        const src = props.src;
        const artifactReference = src ? artifactReferenceFromHref(src) : undefined;
        const workspacePath = src ? workspaceImagePathFromSrc(src) : undefined;
        return (
          <MarkdownImage
            {...props}
            key={src}
            artifactReference={artifactReference}
            workspacePath={workspacePath}
            loadWorkspaceImage={linkActions?.loadWorkspaceImage}
            renderArtifactReference={linkActions?.renderArtifactReference}
          />
        );
      },
    };
  }, [linkActions, onOpenSourceLocation]);
  return (
    <>
      <div className="contents" onClickCapture={openMermaidFullscreen}>
        <Streamdown
          {...props}
          components={components}
          className={cn(
            "markdown-content min-w-0 max-w-full break-words [overflow-wrap:anywhere] [&_[data-streamdown=code-block-body]]:overflow-x-hidden [&_[data-streamdown=code-block-body]_pre]:whitespace-pre-wrap [&_[data-streamdown=code-block-body]_pre]:[overflow-wrap:anywhere]",
            codeBlockPresentation,
            richBlockPresentation,
            className,
          )}
          controls={markdownControls}
          isAnimating={false}
          mermaid={mermaidOptions}
          mode="streaming"
          parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocks}
          plugins={plugins}
          skipHtml
        >
          {renderedSource}
        </Streamdown>
      </div>
      {fullscreenMermaid && (
        <MermaidFullscreen
          svg={fullscreenMermaid}
          onClose={() => setFullscreenMermaid(undefined)}
        />
      )}
    </>
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
