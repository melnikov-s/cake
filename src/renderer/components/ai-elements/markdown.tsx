import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useDeferredValue,
  useMemo,
  useState,
} from "react";
import type { ComponentProps, ReactNode } from "react";
import type { Code, Root, RootContent } from "mdast";
import remarkParse from "remark-parse";
import {
  parseMarkdownIntoBlocks,
  Streamdown,
  type Components,
  type StreamdownProps,
} from "streamdown";
import { unified } from "unified";
import { usePhoneLayout } from "../../lib/phone-layout";
import { DiagramContext } from "../../lib/diagram-context";
import {
  supportsSyntaxHighlightLanguage,
  syntaxHighlighter,
  syntaxHighlightLanguageNames,
} from "@/lib/syntax-highlighter";
import { cn } from "@/lib/utils";
import type { SourceLocation } from "../../../contracts/editor/source-location";
import { parseSubagentLink, subagentLink } from "../../../contracts/subagents/subagent-reference";
import { parseSessionLink, sessionLink } from "../../../contracts/conversations/message-reference";
import { parseSourceLocation } from "../../../utils/source-location";
import { resolveSessionLinkReference } from "../../../contracts/project-sessions/session-reference";
import { sessionDisplayId } from "../../lib/session-display-id";
import { Link, type LinkProps } from "../ui/link";
import { MarkdownTable } from "../ui/markdown-table";
import { FullscreenSurface } from "../fullscreen-surface";
import { PeleDiagram } from "../pele-diagram";
import { MarkdownImage } from "../markdown-image";
import { MarkdownCodeBlock, streamingCodeMarker } from "./markdown-code-block";

/** Matches web-style hrefs that must never be treated as workspace file paths. */
const nonPathHref = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
const workspacePathPrefix = "/__cake_workspace__/";
const sessionPathPrefix = "/__cake_session__/";
const artifactPathPrefix = "/__cake_artifact__/";
const subagentPathPrefix = "/__cake_subagent__/";
const protectedMarkdown = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|!?\[[^\]]*\]\([^)]+\))/g;
const bareSourceReference =
  /(^|[\s(])((?:[^\s/:#()[\],]+\/)*[^\s/:#()[\],]+\.[a-z][a-z0-9._+-]*(?::\d+(?::\d+)?|#L\d+(?:-L?\d+)?(?:,L\d+(?:-L?\d+)?)*)?)(?=$|[\s),.;!?])/gi;
const bareArtifactReference =
  /(^|[\s(])(cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:@r[1-9][0-9]*)?)(?=$|[\s),.;!?])/g;

type AnchorProps = LinkProps & { node?: unknown };
type ImageProps = ComponentProps<"img"> & { node?: unknown };

type MarkdownLinkActions = {
  openExternalUrl(url: string): void;
  openArtifact?(reference: string): void;
  openSession(sessionId: string, messageId?: string, attachmentId?: string): void;
  openSubagent?(parentSessionId: string, handleId: string, messageId?: string): void;
  sessionTitle?(sessionId: string): string | undefined;
  sessionIds?(): readonly string[];
  loadWorkspaceImage?(
    path: string,
    signal: AbortSignal,
  ): Promise<{ readonly data: string; readonly mimeType: string }>;
  loadAttachmentImage?(
    reference: string,
    signal: AbortSignal,
  ): Promise<{ readonly data: string; readonly mimeType: string }>;
  renderArtifactReference?(reference: string, label?: ReactNode): ReactNode;
  renderArtifactEmbed?(reference: string, label?: string, surfaceId?: string): ReactNode;
};

const MarkdownLinkContext = createContext<MarkdownLinkActions | undefined>(undefined);

/** Reuse the conversation's navigation for structured source attribution. */
export function useMarkdownLinkActions() {
  return useContext(MarkdownLinkContext);
}

export function MarkdownLinkProvider({
  actions,
  children,
}: {
  actions: MarkdownLinkActions;
  children: ReactNode;
}) {
  return <MarkdownLinkContext value={actions}>{children}</MarkdownLinkContext>;
}

function sessionTargetFromHref(href: string) {
  return parseSessionLink(
    href.startsWith(sessionPathPrefix)
      ? `cake://session/${href.slice(sessionPathPrefix.length)}`
      : href,
  );
}

function subagentTargetFromHref(href: string) {
  return parseSubagentLink(
    href.startsWith(subagentPathPrefix)
      ? `cake://subagent/${href.slice(subagentPathPrefix.length)}`
      : href,
  );
}

function sourceHref(reference: string) {
  // Keep dot segments and fragments opaque until our click handler sees the originating path.
  return `${workspacePathPrefix}${encodeURIComponent(reference)}`;
}

function sourceReferenceFromHref(href: string) {
  if (!href.startsWith(workspacePathPrefix)) return href.startsWith("./") ? href.slice(2) : href;
  try {
    return decodeURIComponent(href.slice(workspacePathPrefix.length));
  } catch {
    return undefined;
  }
}

function workspaceImagePathFromSrc(src: string) {
  const reference = sourceReferenceFromHref(src);
  if (!reference) return undefined;
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

/** `file:///tmp/a.png` becomes `/tmp/a.png`; other targets are returned unchanged. */
function localPathFromFileUrl(target: string) {
  if (!/^file:\/\//i.test(target)) return target;
  try {
    const url = new URL(target);
    return url.hostname && url.hostname !== "localhost"
      ? undefined
      : decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}

/** Makes Cake session links and workspace source references parseable and clickable. */
function prepareMarkdownLinks(markdown: string, sourceLinks: boolean, workspaceImages: boolean) {
  return markdown
    .split(protectedMarkdown)
    .map((segment, index) => {
      if (index % 2 === 1) {
        return segment.replace(
          /\]\(([^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)$/,
          (match, target: string) => {
            const subagent = subagentTargetFromHref(target);
            if (subagent)
              return `](${subagentPathPrefix}${subagentLink(subagent.parentSessionId, subagent.handleId, subagent.messageId).slice("cake://subagent/".length)})`;
            const session = sessionTargetFromHref(target);
            if (session)
              return `](${sessionPathPrefix}${sessionLink(session.sessionId, session.messageId, session.attachmentId).slice("cake://session/".length)})`;
            const artifactReference = artifactReferenceFromHref(target);
            if (artifactReference)
              return `](${artifactPathPrefix}${encodeURIComponent(artifactReference)})`;
            // Streamdown blocks bare relative image URLs before our renderer sees
            // them. Rewrite local paths, including file: URLs for images, so
            // Cake's image reader can load them from anywhere on this host.
            const image = workspaceImages && segment.startsWith("![");
            const path = image ? localPathFromFileUrl(target) : target;
            return (sourceLinks || image) && path && parseSourceLocation(path)
              ? `](${sourceHref(path)})`
              : match;
          },
        );
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
  const props = { showIcon: true, ...allProps };
  delete props.node;
  const href = props.href;
  const artifactReference = href ? artifactReferenceFromHref(href) : undefined;
  if (artifactReference && actions?.renderArtifactReference)
    return actions.renderArtifactReference(
      artifactReference,
      props.children === artifactReference ? undefined : props.children,
    );
  const subagent = href ? subagentTargetFromHref(href) : undefined;
  if (subagent) {
    const reference = subagentLink(subagent.parentSessionId, subagent.handleId, subagent.messageId);
    return (
      <Link
        {...props}
        href={reference}
        title={reference}
        onClick={(event) => {
          event.preventDefault();
          actions?.openSubagent?.(subagent.parentSessionId, subagent.handleId, subagent.messageId);
        }}
      />
    );
  }
  const session = href ? sessionTargetFromHref(href) : undefined;
  if (session) {
    const ids = actions?.sessionIds?.() ?? [];
    const resolved = resolveSessionLinkReference(session.sessionId, ids);
    const sessionId = resolved.ok ? resolved.sessionId : session.sessionId;
    // Only identity-only labels change. Authored titles and prose remain literal.
    const displayLabel = (label: ReactNode): ReactNode => {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- ReactNode is an already-typed React union, not an unparsed input.
      if (typeof label === "string") {
        const target = resolveSessionLinkReference(label, [...ids, sessionId]);
        return target.ok && target.sessionId === sessionId
          ? sessionDisplayId(sessionId, ids)
          : label;
      }
      if (
        isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(label) &&
        (label.type === "code" || label.props.node?.tagName === "code")
      )
        return cloneElement(label, {}, displayLabel(label.props.children));
      return label;
    };
    const children = Children.toArray(props.children);
    const label = children.length === 1 ? displayLabel(children[0]) : props.children;
    return (
      <Link
        {...props}
        href={sessionLink(sessionId, session.messageId, session.attachmentId)}
        title={sessionLink(sessionId, session.messageId, session.attachmentId)}
        children={label}
        className={cn("inline-block max-w-[80ch] truncate align-bottom", props.className)}
        onClick={(event) => {
          event.preventDefault();
          if (session.attachmentId)
            actions?.openSession(sessionId, undefined, session.attachmentId);
          else if (session.messageId) actions?.openSession(sessionId, session.messageId);
          else actions?.openSession(sessionId);
        }}
      />
    );
  }
  const external = href ? /^https?:\/\//i.test(href) : false;
  return (
    <Link
      {...props}
      href={artifactReference ?? href}
      title={artifactReference ?? href}
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

/** Structured links reuse exactly the same destination handling as conversation Markdown. */
export function MarkdownLink({
  onOpenSourceLocation,
  ...allProps
}: AnchorProps & {
  onOpenSourceLocation?(location: SourceLocation): void;
}) {
  const actions = useMarkdownLinkActions();
  const phone = usePhoneLayout();
  const href = allProps.href;
  const reference = href ? sourceReferenceFromHref(href) : undefined;
  const location = reference ? parseSourceLocation(reference) : undefined;
  if (
    !onOpenSourceLocation ||
    !href ||
    !location ||
    (nonPathHref.test(href) && !href.startsWith(workspacePathPrefix))
  )
    return linkAnchor(allProps, actions);
  // Keep source references readable, without an editor entry point on phones.
  if (phone) return <span>{allProps.children}</span>;
  const props = { showIcon: true, ...allProps, href: reference };
  delete props.node;
  return (
    <Link
      {...props}
      title={reference}
      onClick={(event) => {
        event.preventDefault();
        onOpenSourceLocation(location);
      }}
    />
  );
}

const configuredPlugins = {
  code: syntaxHighlighter,
  renderers: [
    { component: PeleDiagram, language: "mermaid" },
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
};

const codeBlockPresentation =
  "[&_[data-streamdown=code-block]]:relative [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-transparent [&_[data-streamdown=code-block]]:p-0 [&_[data-streamdown=code-block-header]]:hidden [&_[data-streamdown=code-block-actions]]:!absolute [&_[data-streamdown=code-block-actions]]:!top-2 [&_[data-streamdown=code-block-actions]]:!right-2 [&_[data-streamdown=code-block-actions]]:!mt-0 [&_[data-streamdown=code-block-actions]]:!h-auto [&_[data-streamdown=code-block-actions]]:opacity-0 [&_[data-streamdown=code-block-actions]]:transition-opacity [&_[data-streamdown=code-block-actions]>div]:!border-0 [&_[data-streamdown=code-block-actions]>div]:!bg-transparent [&_[data-streamdown=code-block-actions]>div]:!p-0 [&_[data-streamdown=code-block-actions]>div]:!backdrop-blur-none [&_[data-streamdown=code-block]:hover_[data-streamdown=code-block-actions]]:opacity-100 [&_[data-streamdown=code-block]:focus-within_[data-streamdown=code-block-actions]]:opacity-100";

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

/** A lone diagram already owns its fullscreen action in the diagram toolbar. */
export function isStandaloneDiagram(markdown: string): boolean {
  const { children } = markdownParser.parse(markdown);
  return children.length === 1 && children[0]?.type === "code" && children[0].lang === "mermaid";
}

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
    (!supportsSyntaxHighlightLanguage(language) && language.toLowerCase() !== "mermaid")
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
  | "mermaid"
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
  /** Exact references already rendered at their publication position in this conversation. */
  omitArtifactEmbeds?: readonly string[];
  /** Invoked when the reader selects a workspace source reference. */
  onOpenSourceLocation?(location: SourceLocation): void;
};

type RichMarkdownPlugins = Partial<Pick<NonNullable<StreamdownProps["plugins"]>, "math">>;

const MathMarkdown = lazy(async () => {
  const [{ math }] = await Promise.all([
    import("@streamdown/math"),
    import("katex/dist/katex.min.css"),
  ]);
  return {
    default: (props: MarkdownProps) => <MarkdownRenderer {...props} richPlugins={{ math }} />,
  };
});

function richMarkdownFeatures(source: string, normalizeLatexDelimiters = true) {
  return {
    math: /\$\$/.test(source) || (normalizeLatexDelimiters && /\\\(|\\\[/.test(source)),
  };
}

export function Markdown(props: MarkdownProps) {
  // Keep math plugin selection stable as streaming settles.
  const features = richMarkdownFeatures(
    props.children,
    props.streaming || props.normalizeLatexDelimiters !== false,
  );
  const RichMarkdown = features.math ? MathMarkdown : undefined;
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
  omitArtifactEmbeds,
  onOpenSourceLocation,
  richPlugins,
  ...props
}: MarkdownProps & { richPlugins?: RichMarkdownPlugins }) {
  const linkActions = useContext(MarkdownLinkContext);
  const [fullscreenDiagram, setFullscreenDiagram] = useState<string>();
  const [fullscreenTable, setFullscreenTable] = useState<ReactNode>();
  const plugins = useMemo(
    () => (richPlugins ? { ...configuredPlugins, ...richPlugins } : configuredPlugins),
    [richPlugins],
  );
  const source = prepareMarkdownLinks(
    normalizeLatexDelimiters ? normalizeLatexMathDelimiters(children) : children,
    Boolean(onOpenSourceLocation),
    Boolean(linkActions?.loadWorkspaceImage),
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
  const navigateDiagram = useCallback(
    (href: string) => {
      const artifact = artifactReferenceFromHref(href);
      if (artifact) {
        linkActions?.openArtifact?.(artifact);
        return;
      }
      const session = sessionTargetFromHref(href);
      if (session) {
        const resolved = resolveSessionLinkReference(
          session.sessionId,
          linkActions?.sessionIds?.() ?? [],
        );
        linkActions?.openSession(
          resolved.ok ? resolved.sessionId : session.sessionId,
          session.messageId,
          session.attachmentId,
        );
        return;
      }
      const subagent = subagentTargetFromHref(href);
      if (subagent) {
        linkActions?.openSubagent?.(
          subagent.parentSessionId,
          subagent.handleId,
          subagent.messageId,
        );
        return;
      }
      const location = sourceReferenceFromHref(href);
      const source =
        location && !nonPathHref.test(location) ? parseSourceLocation(location) : undefined;
      if (source) {
        onOpenSourceLocation?.(source);
        return;
      }
      if (/^https?:\/\//i.test(href)) linkActions?.openExternalUrl(href);
    },
    [linkActions, onOpenSourceLocation],
  );
  const diagramActions = useMemo(
    () => ({
      openFullscreen: setFullscreenDiagram,
      navigate: navigateDiagram,
    }),
    [navigateDiagram],
  );
  const components = useMemo<Components>(() => {
    const openSourceLocation = onOpenSourceLocation;
    return {
      table(allProps) {
        const props = { ...allProps };
        delete props.node;
        return <MarkdownTable {...props} onFullscreen={setFullscreenTable} />;
      },
      p({ node, children, ...paragraphProps }) {
        // Only a standalone artifact image is a block embed. Prose links and
        // images mixed with text retain their ordinary inline link behavior.
        const image = node?.children.length === 1 ? node.children[0] : undefined;
        if (
          image?.type === "element" &&
          image.tagName === "img" &&
          linkActions?.renderArtifactEmbed
        ) {
          const src = image.properties.src;
          const reference = src ? artifactReferenceFromHref(String(src)) : undefined;
          if (reference && omitArtifactEmbeds?.includes(reference)) return null;
          if (reference)
            return linkActions.renderArtifactEmbed(
              reference,
              image.properties.alt === undefined ? undefined : String(image.properties.alt),
              String(node?.position?.start.offset ?? 0),
            );
        }
        return <p {...paragraphProps}>{children}</p>;
      },
      a({ node, ...allProps }) {
        // Linked images keep their image presentation, not a text-link adornment.
        const containsImage = (children: NonNullable<typeof node>["children"]): boolean =>
          children.some(
            (child) =>
              child.type === "element" &&
              (child.tagName === "img" || containsImage(child.children)),
          );
        const hasImage = node && containsImage(node.children);
        return (
          <MarkdownLink
            {...allProps}
            showIcon={!hasImage}
            onOpenSourceLocation={openSourceLocation}
          />
        );
      },
      img(allProps: ImageProps) {
        const props = { ...allProps };
        delete props.node;
        const src = props.src;
        const artifactReference = src ? artifactReferenceFromHref(src) : undefined;
        const workspacePath = src ? workspaceImagePathFromSrc(src) : undefined;
        const attachment = src ? sessionTargetFromHref(src) : undefined;
        const attachmentReference = attachment?.attachmentId
          ? sessionLink(attachment.sessionId, undefined, attachment.attachmentId)
          : undefined;
        return (
          <MarkdownImage
            {...props}
            key={src}
            artifactReference={artifactReference}
            resourcePath={attachmentReference ?? workspacePath}
            caption={workspacePath}
            loadImage={
              attachmentReference
                ? linkActions?.loadAttachmentImage
                : linkActions?.loadWorkspaceImage
            }
            renderArtifactReference={linkActions?.renderArtifactReference}
          />
        );
      },
    };
  }, [linkActions, omitArtifactEmbeds, onOpenSourceLocation]);
  return (
    <>
      <DiagramContext value={diagramActions}>
        <Streamdown
          {...props}
          components={components}
          className={cn(
            "markdown-content min-w-0 max-w-full break-words [overflow-wrap:anywhere] [&_[data-streamdown=code-block-body]]:overflow-x-hidden [&_[data-streamdown=code-block-body]_pre]:whitespace-pre-wrap [&_[data-streamdown=code-block-body]_pre]:[overflow-wrap:anywhere]",
            codeBlockPresentation,
            className,
          )}
          controls={markdownControls}
          isAnimating={false}
          mode="streaming"
          parseMarkdownIntoBlocksFn={parseMarkdownIntoBlocks}
          plugins={plugins}
          skipHtml
        >
          {renderedSource}
        </Streamdown>
      </DiagramContext>
      {fullscreenTable && (
        <FullscreenSurface
          eyebrow="Table"
          title="Table"
          onClose={() => setFullscreenTable(undefined)}
        >
          {fullscreenTable}
        </FullscreenSurface>
      )}
      {fullscreenDiagram && (
        <FullscreenSurface
          eyebrow="Diagram"
          mode="canvas"
          title="Diagram"
          onClose={() => setFullscreenDiagram(undefined)}
        >
          <DiagramContext value={diagramActions}>
            <PeleDiagram code={fullscreenDiagram} fullscreen />
          </DiagramContext>
        </FullscreenSurface>
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
