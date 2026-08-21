import { Fragment, useEffect, useState, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { ReviewThread } from "../../models/ReviewThread";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { extractSourceSelection } from "./source-selection";
import { Chat } from "./chat";
import { highlightSource, syntaxTokenStyle, type HighlightTokens } from "./ai-elements/code";
export { selectionColumn } from "./source-selection";
export function useFileContent(path: string, readFile: (path: string) => Promise<string>) {
  const [state, setState] = useState<{
    path: string;
    source?: string;
    tokens?: HighlightTokens;
    error?: string;
  }>({ path });
  useEffect(() => {
    let active = true;
    setState({ path });
    void readFile(path)
      .then((source) => {
        if (!active) return;
        setState({ path, source });
        highlightSource(path, source, (tokens) => {
          if (active) setState({ path, source, tokens });
        });
      })
      .catch((reason: unknown) => {
        if (active)
          setState({
            path,
            error: reason instanceof Error ? reason.message : "The file could not be loaded",
          });
      });
    return () => {
      active = false;
    };
  }, [path, readFile]);
  return state.path === path ? state : { path };
}

function sourceAnchor(
  path: string,
  view: "full" | "file",
  lines: string[],
  diff: string,
  startIndex: number,
  endIndex: number,
  selectedText: string,
  startColumn?: number,
  endColumn?: number,
): ReviewAnchor {
  return {
    path,
    view,
    start: {
      diffLine: startIndex,
      oldLine: startIndex + 1,
      newLine: startIndex + 1,
      column: startColumn,
    },
    end: { diffLine: endIndex, oldLine: endIndex + 1, newLine: endIndex + 1, column: endColumn },
    selectedText,
    contextBefore: lines.slice(Math.max(0, startIndex - 3), startIndex).join("\n"),
    contextAfter: lines.slice(endIndex + 1, endIndex + 4).join("\n"),
    diff,
  };
}

export const ReviewDraftCard = observer(function ReviewDraftCard({
  anchor,
  store,
  onCancel,
}: {
  anchor: ReviewAnchor;
  store: ReviewsStore;
  onCancel(): void;
}) {
  if (store.draftAnchor !== anchor) return null;
  const cancel = () => {
    store.cancelDraft();
    onCancel();
    window.getSelection()?.removeAllRanges();
  };
  return (
    <article
      className="review-thread review-thread-draft"
      aria-label={`New code chat on ${anchor.path}`}
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }}
    >
      <header>
        <span>
          <i />
          New code chat
        </span>
        <div>
          <button type="button" onClick={cancel}>
            Cancel
          </button>
        </div>
      </header>
      <Chat store={store.draftChatStore} embedded compact />
    </article>
  );
});

export const ReviewThreadCard = observer(function ReviewThreadCard({
  thread,
  store,
  onFocus,
}: {
  thread: ReviewThread;
  store: ReviewsStore;
  onFocus?: () => void;
}) {
  const [expanded, setExpanded] = useState(thread.status === "open");
  const chat = store.chatStore(thread.id);
  const focus = () => (onFocus ? onFocus() : (store.activeThreadId = thread.id));
  if (!expanded)
    return (
      <button
        className={`review-thread-collapsed ${thread.status} ${store.activeThread?.id === thread.id ? "active" : ""}`}
        aria-label="Expand review thread"
        data-review-thread-id={thread.id}
        onClick={() => {
          focus();
          setExpanded(true);
        }}
      >
        {thread.status === "resolved" ? "✓ Resolved thread" : "Review thread"} ·{" "}
        {thread.messageCount} messages
      </button>
    );
  return (
    <article
      className={`review-thread ${thread.status} ${store.activeThread?.id === thread.id ? "active" : ""}`}
      data-review-thread-id={thread.id}
      aria-label={`Review thread on ${thread.anchor.path}`}
      onClick={focus}
    >
      <header>
        <button
          type="button"
          className="review-thread-header-toggle"
          aria-label="Collapse review thread"
          onClick={() => {
            focus();
            setExpanded(false);
          }}
        >
          <span>
            <i />
            {thread.status === "resolved"
              ? "Resolved"
              : store.threadStreaming(thread.id)
                ? "Working"
                : thread.pending
                  ? "Pending review"
                  : "Review thread"}
          </span>
        </button>
        <div onClick={(event) => event.stopPropagation()}>
          {thread.status === "resolved" ? (
            <button onClick={() => void store.resolveThread(thread.id, false)}>Reopen</button>
          ) : (
            <button
              onClick={() => {
                setExpanded(false);
                void store.resolveThread(thread.id);
              }}
            >
              Resolve
            </button>
          )}
        </div>
      </header>
      {chat && <Chat store={chat} embedded compact />}
    </article>
  );
});

interface SourceReviewProps {
  path: string;
  view: "full" | "file";
  lines: string[];
  tokens?: HighlightTokens;
  diff: string;
  reviews: ReviewsStore;
  threads: ReviewThread[];
  ariaLabel: string;
  className?: string;
  actionLabel?: string;
  lineClass?(line: string, index: number): string;
  prefix?(line: string, index: number): ReactNode;
  beforeLine?(index: number): ReactNode;
  afterLines?: ReactNode;
  onFocusThread?(thread: ReviewThread): void;
}

export const SourceReview = observer(function SourceReview({
  path,
  view,
  lines,
  tokens,
  diff,
  reviews,
  threads,
  ariaLabel,
  className = "",
  actionLabel = "Comment on",
  lineClass,
  prefix,
  beforeLine,
  afterLines,
  onFocusThread,
}: SourceReviewProps) {
  const [composer, setComposer] = useState<{ anchor: ReviewAnchor }>();
  useEffect(() => () => reviews.cancelDraft(), [path, view, reviews]);
  const makeAnchor = (
    startIndex: number,
    endIndex: number,
    selectedText: string,
    startColumn?: number,
    endColumn?: number,
  ) =>
    sourceAnchor(
      path,
      view,
      lines,
      diff,
      startIndex,
      endIndex,
      selectedText,
      startColumn,
      endColumn,
    );
  const openComposer = (anchor: ReviewAnchor) => {
    reviews.prepareDraft(anchor);
    setComposer({ anchor });
  };
  const cancelComposer = () => {
    reviews.cancelDraft();
    setComposer(undefined);
  };
  const openFromLineAction = (button: HTMLButtonElement, index: number, line: string) => {
    const container = button.closest<HTMLElement>('[role="table"]');
    const selected =
      container &&
      extractSourceSelection(
        container,
        ".change-explorer-line[data-source-index]",
        "data-source-index",
      );
    openComposer(
      selected && selected.selectedText
        ? makeAnchor(
            selected.startIndex,
            selected.endIndex,
            selected.selectedText,
            selected.startColumn,
            selected.endColumn,
          )
        : makeAnchor(index, index, line, 0, line.length),
    );
  };
  return (
    <div
      className={`change-explorer-diff change-explorer-full-file ${className}`.trim()}
      role="table"
      aria-label={ariaLabel}
    >
      {lines.map((line, index) => (
        <Fragment key={index}>
          {beforeLine?.(index)}
          <div
            className={`change-explorer-line ${lineClass?.(line, index) ?? "context"}`}
            data-source-index={index}
            role="row"
          >
            <span className="review-gutter">
              <button
                aria-label={`${actionLabel} line ${index + 1}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => openFromLineAction(event.currentTarget, index, line)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 3.25v9.5M3.25 8h9.5" />
                </svg>
              </button>
              {index + 1}
            </span>
            <code>
              <b data-review-prefix>{prefix?.(line, index) ?? " "}</b>
              {(tokens?.[index] ?? []).length > 0
                ? tokens![index]!.map((token, tokenIndex) => (
                    <i
                      className="syntax-token"
                      style={syntaxTokenStyle(token)}
                      key={`${tokenIndex}-${token.content}`}
                    >
                      {token.content}
                    </i>
                  ))
                : line || " "}
            </code>
          </div>
          {composer && composer.anchor.end.diffLine === index && (
            <ReviewDraftCard anchor={composer.anchor} store={reviews} onCancel={cancelComposer} />
          )}
          {threads
            .filter((thread) => thread.anchor.end.diffLine === index)
            .map((thread) => (
              <ReviewThreadCard
                key={`${thread.id}:${thread.status}`}
                thread={thread}
                store={reviews}
                onFocus={onFocusThread ? () => onFocusThread(thread) : undefined}
              />
            ))}
        </Fragment>
      ))}
      {afterLines}
    </div>
  );
});

export function reviewThreadPreview(thread: ReviewThread, fallback: string) {
  const body = thread.textParts.find((message) => message.role === "user")?.text ?? fallback;
  return body.length > 72 ? `${body.slice(0, 72)}…` : body;
}
