import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { observer } from "r-state-tree/react";
import type { ChangedFile } from "../../ipc/session-contract";
import type { ReviewAnchor, ReviewPoint } from "../../ipc/review-contract";
import { parseDiff } from "./ai-elements/diff-view";
import { Button } from "./ui/button";
import { LoadingState } from "./ui/loading-state";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { ChangesStore } from "../stores/ChangesStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import type { BrowseStore } from "../stores/BrowseStore";
import type { ReviewThreadModel } from "../models/review-thread";
import {
  ReviewDraftCard,
  ReviewThreadCard,
  SourceReview,
  reviewThreadPreview,
  useFileContent,
  useHighlightedSource,
} from "./source-review";
import { extractSourceSelection } from "./source-selection";
import { SourceExplorerLayout, SourceTree, sourceTree } from "./source-explorer";
import { PanelResizeHandle } from "./panel-resize-handle";

function reviewPoint(
  lines: ReturnType<typeof parseDiff>,
  index: number,
  column?: number,
): ReviewPoint {
  const line = lines[index]!;
  return { diffLine: index, oldLine: line.oldNumber, newLine: line.newNumber, column };
}

function reviewAnchor(
  change: ChangedFile,
  lines: ReturnType<typeof parseDiff>,
  startIndex: number,
  endIndex: number,
  selectedText: string,
  startColumn?: number,
  endColumn?: number,
): ReviewAnchor {
  const content = (line: (typeof lines)[number]) =>
    line.kind === "meta" ? line.content : line.content;
  return {
    path: change.path,
    start: reviewPoint(lines, startIndex, startColumn),
    end: reviewPoint(lines, endIndex, endColumn),
    selectedText,
    contextBefore: lines
      .slice(Math.max(0, startIndex - 3), startIndex)
      .map(content)
      .join("\n"),
    contextAfter: lines
      .slice(endIndex + 1, endIndex + 4)
      .map(content)
      .join("\n"),
    diff: change.diff,
  };
}

function threadLocation(thread: ReviewThreadModel) {
  const start = thread.anchor.start.newLine ?? thread.anchor.start.oldLine;
  const end = thread.anchor.end.newLine ?? thread.anchor.end.oldLine;
  return start && end && start !== end
    ? `${thread.anchor.path} · L${start}–${end}`
    : start
      ? `${thread.anchor.path} · L${start}`
      : thread.anchor.path;
}

function scrollToReviewThread(threadId: string) {
  [...document.querySelectorAll<HTMLElement>("[data-review-thread-id]")]
    .find((element) => element.dataset.reviewThreadId === threadId)
    ?.scrollIntoView({ block: "center" });
}

function changeSection(container: HTMLElement, path: string) {
  return [...container.querySelectorAll<HTMLElement>("[data-change-path]")].find(
    (element) => element.dataset.changePath === path,
  );
}

function scrollToChange(container: HTMLElement | null, path: string) {
  if (!container) return;
  changeSection(container, path)?.scrollIntoView?.({ block: "start" });
}

function activeChangePath(container: HTMLElement) {
  const sections = [...container.querySelectorAll<HTMLElement>("[data-change-path]")];
  if (
    container.scrollHeight > container.clientHeight + 2 &&
    container.scrollTop + container.clientHeight >= container.scrollHeight - 2
  )
    return sections.at(-1)?.dataset.changePath;
  const boundary = container.getBoundingClientRect().top + 24;
  let active = sections[0];
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= boundary) active = section;
  }
  return active?.dataset.changePath;
}

const HighlightedDiff = observer(function HighlightedDiff({
  change,
  reviews,
  store,
  reviewable = true,
  className = "",
}: {
  change: ChangedFile;
  reviews: ReviewsStore;
  store: ChangesStore;
  reviewable?: boolean;
  className?: string;
}) {
  const lines = useMemo(() => parseDiff(change.diff), [change.diff]);
  const source = useMemo(
    () => lines.map((line) => (line.kind === "meta" ? "" : line.content)).join("\n"),
    [lines],
  );
  const tokens = useHighlightedSource(change.path, source);
  const [composer, setComposer] = useState<{ anchor: ReviewAnchor }>();
  const threads = reviewable
    ? reviews.threads.filter(
        (thread) =>
          thread.anchor.view !== "file" &&
          thread.anchor.view !== "full" &&
          thread.anchor.view !== "message" &&
          store.changeMatchesPath(change, thread.anchor.path),
      )
    : [];
  useEffect(() => () => reviews.cancelDraft(), [change.path, reviews]);
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
        ".change-explorer-line[data-diff-index]",
        "data-diff-index",
      );
    openComposer(
      selected && selected.selectedText
        ? reviewAnchor(
            change,
            lines,
            selected.startIndex,
            selected.endIndex,
            selected.selectedText,
            selected.startColumn,
            selected.endColumn,
          )
        : reviewAnchor(change, lines, index, index, line, 0, line.length),
    );
  };

  return (
    <div
      className={`change-explorer-diff ${className}`.trim()}
      role="table"
      aria-label={`Changes to ${change.path}`}
    >
      {lines.map((line, index) =>
        line.kind === "meta" ? (
          <div className="change-explorer-line meta" role="row" key={line.key}>
            <span />
            <span />
            <code>{line.content}</code>
          </div>
        ) : (
          <Fragment key={line.key}>
            <div className={`change-explorer-line ${line.kind}`} data-diff-index={index} role="row">
              <span className={reviewable ? "review-gutter" : undefined}>
                {reviewable && (
                  <button
                    aria-label={`Comment on line ${line.newNumber ?? line.oldNumber}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) =>
                      openFromLineAction(event.currentTarget, index, line.content)
                    }
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M8 3.25v9.5M3.25 8h9.5" />
                    </svg>
                  </button>
                )}
                {line.oldNumber}
              </span>
              <span>{line.newNumber}</span>
              <code>
                <b data-review-prefix>
                  {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
                </b>
                {(tokens?.[index] ?? []).length > 0
                  ? tokens![index]!.map((token, tokenIndex) => (
                      <i
                        className="syntax-token"
                        style={token.htmlStyle}
                        key={`${tokenIndex}-${token.content}`}
                      >
                        {token.content}
                      </i>
                    ))
                  : line.content || " "}
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
                />
              ))}
          </Fragment>
        ),
      )}
    </div>
  );
});

const FullDiff = observer(function FullDiff({
  changes,
  reviews,
  store,
}: {
  changes: readonly ChangedFile[];
  reviews: ReviewsStore;
  store: ChangesStore;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedPathRef = useRef<string | undefined>(undefined);
  const selectedPath = store.selected?.path;
  const changeKey = changes.map((change) => change.path).join("\u0000");

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    if (selectedPath && selectedPathRef.current !== selectedPath) {
      selectedPathRef.current = selectedPath;
      scrollToChange(container, selectedPath);
    }
    const onScroll = () => {
      const path = activeChangePath(container);
      if (!path || path === selectedPathRef.current) return;
      selectedPathRef.current = path;
      store.select(path);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [changeKey, selectedPath, store]);

  return (
    <div
      ref={scrollRef}
      className="change-explorer-diff change-explorer-all-diff"
      role="region"
      aria-label={`All workspace changes · ${changes.length} files`}
    >
      {changes.map((item) => (
        <section
          className="change-explorer-file-section"
          data-change-path={item.path}
          aria-label={`Changes to ${item.path}`}
          key={item.path}
        >
          <header className="change-explorer-diff-file-header">
            <strong title={item.previousPath ? `${item.previousPath} → ${item.path}` : item.path}>
              {item.previousPath ? `${item.previousPath} → ${item.path}` : item.path}
            </strong>
            <span>
              <b>+{item.additions}</b>
              <i>−{item.deletions}</i>
            </span>
          </header>
          <HighlightedDiff
            change={item}
            reviews={reviews}
            store={store}
            className="change-explorer-embedded-diff"
          />
        </section>
      ))}
    </div>
  );
});

function FullFile({
  change,
  reviews,
  browse,
  store,
}: {
  change: ChangedFile;
  reviews: ReviewsStore;
  browse: BrowseStore;
  store: ChangesStore;
}) {
  const readFile = useMemo(() => (path: string) => browse.readFile(path), [browse]);
  const content = useFileContent(change.path, readFile);
  if (content.error)
    return (
      <div className="change-explorer-file-state" role="alert">
        <strong>Unable to show the full file</strong>
        <span>{content.error}</span>
      </div>
    );
  if (content.source === undefined)
    return (
      <div className="change-explorer-file-state">
        <LoadingState label="Loading full file" />
      </div>
    );
  const sourceLines = content.source.split("\n");
  const threads = reviews.threads.filter(
    (thread) =>
      thread.anchor.view === "full" && store.changeMatchesPath(change, thread.anchor.path),
  );
  const diffLines = parseDiff(change.diff);
  const addedLines = new Set(
    diffLines
      .filter((line) => line.kind === "add" && line.newNumber !== undefined)
      .map((line) => line.newNumber!),
  );
  const removalsBefore = new Map<number, typeof diffLines>();
  diffLines.forEach((line, index) => {
    if (line.kind !== "remove") return;
    let insertionLine: number | undefined;
    for (
      let nextIndex = index + 1;
      nextIndex < diffLines.length && diffLines[nextIndex]!.kind !== "meta";
      nextIndex++
    ) {
      if (diffLines[nextIndex]!.newNumber !== undefined) {
        insertionLine = diffLines[nextIndex]!.newNumber;
        break;
      }
    }
    if (insertionLine === undefined) {
      for (
        let previousIndex = index - 1;
        previousIndex >= 0 && diffLines[previousIndex]!.kind !== "meta";
        previousIndex--
      ) {
        if (diffLines[previousIndex]!.newNumber !== undefined) {
          insertionLine = diffLines[previousIndex]!.newNumber! + 1;
          break;
        }
      }
    }
    insertionLine ??= 1;
    const removals = removalsBefore.get(insertionLine) ?? [];
    removals.push(line);
    removalsBefore.set(insertionLine, removals);
  });
  const removedRows = (lineNumber: number) =>
    (removalsBefore.get(lineNumber) ?? []).map((line) => (
      <div className="change-explorer-line remove" role="row" key={`remove-${line.key}`}>
        <span>{line.oldNumber}</span>
        <code>
          <b>−</b>
          {line.content || " "}
        </code>
      </div>
    ));
  return (
    <SourceReview
      path={change.path}
      view="full"
      lines={sourceLines}
      tokens={content.tokens}
      diff={change.diff}
      reviews={reviews}
      threads={threads}
      ariaLabel={`Full file ${change.path}`}
      lineClass={(_line, index) => (addedLines.has(index + 1) ? "add" : "context")}
      prefix={(_line, index) => (addedLines.has(index + 1) ? "+" : " ")}
      beforeLine={(index) => removedRows(index + 1)}
      afterLines={removedRows(sourceLines.length + 1)}
    />
  );
}

export const ChangeExplorer = observer(function ChangeExplorer({
  store,
  reviews,
  browse,
  chat,
  onClose,
}: {
  store: ChangesStore;
  reviews: ReviewsStore;
  browse: BrowseStore;
  chat: ProjectWorkbenchStore;
  onClose?: () => void;
}) {
  const close = onClose ?? (() => store.close());
  const [view, setView] = useState<"diff" | "file">("diff");
  const [commentsHeight, setCommentsHeight] = useState<number>();
  const [resizingComments, setResizingComments] = useState(false);
  const change = store.selected;
  const tree = sourceTree(store.changes, (item) => item.path);
  const changeThreads = reviews.threads.filter(
    (thread) => thread.anchor.view !== "file" && thread.anchor.view !== "message",
  );
  const indexedThreads = [...changeThreads].sort(
    (left, right) => Number(left.status === "resolved") - Number(right.status === "resolved"),
  );
  const defaultCommentsHeight = Math.min(280, 48 + changeThreads.length * 56);
  const commentsMinHeight = 76;
  const commentsMaxHeight = Math.max(commentsMinHeight, window.innerHeight - 62 - 110);
  const shownCommentsHeight = Math.min(commentsHeight ?? defaultCommentsHeight, commentsMaxHeight);
  const sidebarStyle: CSSProperties & Record<"--review-panel-height", string> = {
    "--review-panel-height": `${shownCommentsHeight}px`,
  };
  const activeChangeThread = changeThreads.find((thread) => thread.id === reviews.activeThreadId);
  const shownView = change?.status === "deleted" ? "diff" : view;
  const focusThread = (threadId: string) => {
    const thread = changeThreads.find((item) => item.id === threadId);
    if (thread) setView(thread.anchor.view === "full" ? "file" : "diff");
    reviews.activeThreadId = threadId;
    store.focusPath(thread!.anchor.path);
    requestAnimationFrame(() => scrollToReviewThread(threadId));
  };
  useEffect(() => {
    if (!activeChangeThread) return;
    setView(activeChangeThread.anchor.view === "full" ? "file" : "diff");
    scrollToReviewThread(activeChangeThread.id);
  }, [change?.path, activeChangeThread?.id, activeChangeThread?.anchor.view]);
  const context = `Working tree · staged, unstaged, and untracked · ${chat.sessionTitle}`;
  const totalAdditions = store.changes.reduce((total, item) => total + item.additions, 0);
  const totalDeletions = store.changes.reduce((total, item) => total + item.deletions, 0);
  const emptyTitle = store.error
    ? "Unable to inspect changes"
    : store.loading
      ? "Loading changes…"
      : "Working tree is clean";
  const emptyDetail =
    store.error ??
    (store.loading
      ? "Reading the current Git working tree."
      : "There are no staged, unstaged, or untracked files.");
  return (
    <SourceExplorerLayout
      resizeLabel="Resize changed files panel"
      file={
        <>
          <header>
            <div>
              <small title={context}>{context}</small>
              <h1>
                {change
                  ? change.previousPath
                    ? `${change.previousPath} → ${change.path}`
                    : change.path
                  : emptyTitle}
              </h1>
            </div>
            {change && (
              <div className="change-explorer-view-toggle" role="group" aria-label="File view">
                <button
                  type="button"
                  className={shownView === "diff" ? "active" : ""}
                  aria-pressed={shownView === "diff"}
                  onClick={() => setView("diff")}
                >
                  Diff
                </button>
                <button
                  type="button"
                  className={shownView === "file" ? "active" : ""}
                  aria-pressed={shownView === "file"}
                  disabled={change.status === "deleted"}
                  onClick={() => setView("file")}
                >
                  Full file
                </button>
              </div>
            )}
            {store.changes.length > 0 && (
              <span>
                <b>+{totalAdditions}</b>
                <i>−{totalDeletions}</i>
              </span>
            )}
          </header>
          {change ? (
            shownView === "diff" ? (
              <FullDiff changes={store.changes} reviews={reviews} store={store} />
            ) : (
              <FullFile change={change} reviews={reviews} browse={browse} store={store} />
            )
          ) : (
            <div className="change-explorer-file-state">
              {store.loading ? (
                <LoadingState label="Loading changes" />
              ) : (
                <>
                  <strong>{emptyTitle}</strong>
                  <span>{emptyDetail}</span>
                </>
              )}
            </div>
          )}
        </>
      }
      sidebar={
        <>
          <header>
            <div>
              <strong>Changed files</strong>
              <small>
                {store.changes.length} {store.changes.length === 1 ? "file" : "files"}
              </small>
            </div>
            <div className="change-explorer-actions">
              <Button variant="ghost" size="sm" onClick={close}>
                Done
              </Button>
            </div>
          </header>
          <div
            className={`change-explorer-sidebar-body ${resizingComments ? "is-resizing" : ""}`}
            style={sidebarStyle}
          >
            <nav aria-label="Changed files">
              <SourceTree
                nodes={tree.children}
                selectedPath={change?.path}
                onSelect={(path) => store.select(path)}
                fileMeta={(item) => (
                  <small>
                    +{item.additions} −{item.deletions}
                  </small>
                )}
              />
            </nav>
            {changeThreads.length > 0 && (
              <>
                <PanelResizeHandle
                  className="review-index-resize-handle"
                  label="Resize comments panel"
                  value={shownCommentsHeight}
                  min={commentsMinHeight}
                  max={commentsMaxHeight}
                  edge="bottom"
                  onChange={setCommentsHeight}
                  onResizeStart={() => setResizingComments(true)}
                  onResizeEnd={() => setResizingComments(false)}
                />
                <section className="review-thread-index" aria-label="Review threads">
                  <header>
                    <strong>Comments</strong>
                    <span>{changeThreads.length}</span>
                  </header>
                  <ol>
                    {indexedThreads.map((thread) => {
                      const state =
                        thread.status === "resolved"
                          ? "Resolved"
                          : reviews.threadStreaming(thread.id)
                            ? "Working"
                            : thread.pending
                              ? "Pending"
                              : "Replied";
                      return (
                        <li key={thread.id}>
                          <button
                            className={`${thread.status === "resolved" ? "resolved" : ""} ${reviews.activeThread?.id === thread.id ? "active" : ""}`}
                            onClick={() => focusThread(thread.id)}
                          >
                            <i className={state.toLowerCase()} />
                            <span>
                              <strong>{reviewThreadPreview(thread, "Review thread")}</strong>
                              <small>{threadLocation(thread)}</small>
                            </span>
                            <em>{state}</em>
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              </>
            )}
          </div>
        </>
      }
    />
  );
});
