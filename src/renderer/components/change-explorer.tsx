import { Fragment, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
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
import { ReviewComposer, ReviewThreadCard, SourceReview, reviewThreadPreview, useFileContent, useHighlightedSource } from "./source-review";
import { extractSourceSelection } from "./source-selection";
import { SourceExplorerLayout, SourceTree, sourceTree } from "./source-explorer";

function reviewPoint(lines: ReturnType<typeof parseDiff>, index: number, column?: number): ReviewPoint {
  const line = lines[index]!;
  return { diffLine: index, oldLine: line.oldNumber, newLine: line.newNumber, column };
}

function reviewAnchor(change: ChangedFile, lines: ReturnType<typeof parseDiff>, startIndex: number, endIndex: number, selectedText: string, startColumn?: number, endColumn?: number): ReviewAnchor {
  const content = (line: (typeof lines)[number]) => line.kind === "meta" ? line.content : line.content;
  return {
    path: change.path,
    start: reviewPoint(lines, startIndex, startColumn),
    end: reviewPoint(lines, endIndex, endColumn),
    selectedText,
    contextBefore: lines.slice(Math.max(0, startIndex - 3), startIndex).map(content).join("\n"),
    contextAfter: lines.slice(endIndex + 1, endIndex + 4).map(content).join("\n"),
    diff: change.diff
  };
}

function threadLocation(thread: ReviewThreadModel) {
  const start = thread.anchor.start.newLine ?? thread.anchor.start.oldLine;
  const end = thread.anchor.end.newLine ?? thread.anchor.end.oldLine;
  return start && end && start !== end ? `${thread.anchor.path} · L${start}–${end}` : start ? `${thread.anchor.path} · L${start}` : thread.anchor.path;
}

function scrollToReviewThread(threadId: string) {
  [...document.querySelectorAll<HTMLElement>("[data-review-thread-id]")].find((element) => element.dataset.reviewThreadId === threadId)?.scrollIntoView({ block: "center" });
}

const HighlightedDiff = observer(function HighlightedDiff({ change, reviews, store, reviewable = true }: { change: ChangedFile; reviews: ReviewsStore; store: ChangesStore; reviewable?: boolean }) {
  const lines = useMemo(() => parseDiff(change.diff), [change.diff]);
  const source = useMemo(() => lines.map((line) => line.kind === "meta" ? "" : line.content).join("\n"), [lines]);
  const tokens = useHighlightedSource(change.path, source);
  const [composer, setComposer] = useState<{ anchor: ReviewAnchor; floating: boolean; position?: { left: number; top: number } }>();
  const threads = reviewable ? reviews.threads.filter((thread) => thread.anchor.view !== "file" && thread.anchor.view !== "full" && thread.anchor.view !== "message" && store.changeMatchesPath(change, thread.anchor.path)) : [];

  const selectText = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!reviewable) return;
    if (event.target instanceof Element && event.target.closest("button, textarea, .review-thread, .review-composer")) return;
    const selected = extractSourceSelection(event.currentTarget, ".change-explorer-line[data-diff-index]", "data-diff-index");
    if (!selected) return;
    setComposer({ anchor: reviewAnchor(change, lines, selected.startIndex, selected.endIndex, selected.selectedText, selected.startColumn, selected.endColumn), floating: true, position: selected.position });
  };

  return <div className="change-explorer-diff" role="table" aria-label={`Changes to ${change.path}`} onMouseUp={selectText}>{lines.map((line, index) => line.kind === "meta"
    ? <div className="change-explorer-line meta" role="row" key={line.key}><span /><span /><code>{line.content}</code></div>
    : <Fragment key={line.key}><div className={`change-explorer-line ${line.kind}`} data-diff-index={index} role="row">
        <span className={reviewable ? "review-gutter" : undefined}>{reviewable && <button aria-label={`Comment on line ${line.newNumber ?? line.oldNumber}`} onClick={() => setComposer({ anchor: reviewAnchor(change, lines, index, index, line.content, 0, line.content.length), floating: false })}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" /></svg></button>}{line.oldNumber}</span><span>{line.newNumber}</span><code><b data-review-prefix>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</b>{(tokens?.[index] ?? []).length > 0
          ? tokens![index]!.map((token, tokenIndex) => <i className="syntax-token" style={token.htmlStyle} key={`${tokenIndex}-${token.content}`}>{token.content}</i>)
          : line.content || " "}</code>
      </div>{composer && !composer.floating && composer.anchor.end.diffLine === index && <ReviewComposer anchor={composer.anchor} onSave={(body) => reviews.createThread(composer.anchor, body)} onCancel={() => setComposer(undefined)} />}{threads.filter((thread) => thread.anchor.end.diffLine === index).map((thread) => <ReviewThreadCard key={`${thread.id}:${thread.status}`} thread={thread} store={reviews} />)}</Fragment>)}
    {composer?.floating && <ReviewComposer anchor={composer.anchor} floating position={composer.position} onSave={(body) => reviews.createThread(composer.anchor, body)} onCancel={() => { setComposer(undefined); window.getSelection()?.removeAllRanges(); }} />}</div>;
});

function FullFile({ change, reviews, browse, store }: { change: ChangedFile; reviews: ReviewsStore; browse: BrowseStore; store: ChangesStore }) {
  const readFile = useMemo(() => (path: string) => browse.readFile(path), [browse]);
  const content = useFileContent(change.path, readFile);
  if (content.error) return <div className="change-explorer-file-state" role="alert"><strong>Unable to show the full file</strong><span>{content.error}</span></div>;
  if (content.source === undefined) return <div className="change-explorer-file-state"><LoadingState label="Loading full file" /></div>;
  const sourceLines = content.source.split("\n");
  const threads = reviews.threads.filter((thread) => thread.anchor.view === "full" && store.changeMatchesPath(change, thread.anchor.path));
  const diffLines = parseDiff(change.diff);
  const addedLines = new Set(diffLines.filter((line) => line.kind === "add" && line.newNumber !== undefined).map((line) => line.newNumber!));
  const removalsBefore = new Map<number, typeof diffLines>();
  diffLines.forEach((line, index) => {
    if (line.kind !== "remove") return;
    let insertionLine: number | undefined;
    for (let nextIndex = index + 1; nextIndex < diffLines.length && diffLines[nextIndex]!.kind !== "meta"; nextIndex++) {
      if (diffLines[nextIndex]!.newNumber !== undefined) { insertionLine = diffLines[nextIndex]!.newNumber; break; }
    }
    if (insertionLine === undefined) {
      for (let previousIndex = index - 1; previousIndex >= 0 && diffLines[previousIndex]!.kind !== "meta"; previousIndex--) {
        if (diffLines[previousIndex]!.newNumber !== undefined) { insertionLine = diffLines[previousIndex]!.newNumber! + 1; break; }
      }
    }
    insertionLine ??= 1;
    const removals = removalsBefore.get(insertionLine) ?? [];
    removals.push(line);
    removalsBefore.set(insertionLine, removals);
  });
  const removedRows = (lineNumber: number) => (removalsBefore.get(lineNumber) ?? []).map((line) => <div className="change-explorer-line remove" role="row" key={`remove-${line.key}`}>
    <span>{line.oldNumber}</span><code><b>−</b>{line.content || " "}</code>
  </div>);
  return <SourceReview path={change.path} view="full" lines={sourceLines} tokens={content.tokens} diff={change.diff} reviews={reviews} threads={threads} ariaLabel={`Full file ${change.path}`} lineClass={(_line, index) => addedLines.has(index + 1) ? "add" : "context"} prefix={(_line, index) => addedLines.has(index + 1) ? "+" : " "} beforeLine={(index) => removedRows(index + 1)} afterLines={removedRows(sourceLines.length + 1)} />;
}

export const ChangeExplorer = observer(function ChangeExplorer({ store, reviews, browse, chat, onClose }: { store: ChangesStore; reviews: ReviewsStore; browse: BrowseStore; chat: ProjectWorkbenchStore; onClose?: () => void }) {
  const close = onClose ?? (() => store.close());
  const [view, setView] = useState<"diff" | "file">("diff");
  const change = store.selected;
  const tree = sourceTree(store.changes, (item) => item.path);
  const changeThreads = reviews.threads.filter((thread) => thread.anchor.view !== "file" && thread.anchor.view !== "message");
  const indexedThreads = [...changeThreads].sort((left, right) => Number(left.status === "resolved") - Number(right.status === "resolved"));
  const activeChangeThread = changeThreads.find((thread) => thread.id === reviews.activeThreadId);
  const pendingCount = reviews.pendingCommentCount;
  const historical = store.source === "conversation-turn";
  const shownView = historical || change?.status === "deleted" ? "diff" : view;
  const focusThread = (threadId: string) => {
    const thread = changeThreads.find((item) => item.id === threadId);
    if (thread) setView(thread.anchor.view === "full" ? "file" : "diff");
    reviews.activeThreadId = threadId;
    store.focusPath(thread!.anchor.path);
    requestAnimationFrame(() => scrollToReviewThread(threadId));
  };
  useEffect(() => {
    if (!activeChangeThread || historical) return;
    setView(activeChangeThread.anchor.view === "full" ? "file" : "diff");
    scrollToReviewThread(activeChangeThread.id);
  }, [change?.path, activeChangeThread?.id, activeChangeThread?.anchor.view, historical]);
  const context = historical
    ? store.selectedTurn ? `Conversation turn · ${new Date(store.selectedTurn.capturedAt).toLocaleString()} · ${chat.sessionTitle}` : `Conversation turns · ${chat.sessionTitle}`
    : `Working tree · staged, unstaged, and untracked · ${chat.sessionTitle}`;
  const emptyTitle = store.error ? "Unable to inspect changes" : store.loading ? "Loading changes…" : historical ? "No recorded turn changes" : "Working tree is clean";
  const emptyDetail = store.error ?? (store.loading ? (historical ? "Comparing the workspace before and after this turn." : "Reading the current Git working tree.") : historical ? "This conversation has no turns with recorded workspace changes." : "There are no staged, unstaged, or untracked files.");
  return <SourceExplorerLayout resizeLabel="Resize changed files panel" file={<>
      <header><div><small>{context}</small><h1>{change ? (change.previousPath ? `${change.previousPath} → ${change.path}` : change.path) : historical && store.selectedTurn ? store.selectedTurn.label : emptyTitle}</h1></div><label className="change-explorer-source"><span>Show</span><select aria-label="Change source" value={store.source} onChange={(event) => void store.selectSource(event.target.value === "conversation-turn" ? "conversation-turn" : "working-tree")}><option value="working-tree">Working tree</option><option value="conversation-turn">By conversation turn</option></select></label>{change && !historical && <div className="change-explorer-view-toggle" role="group" aria-label="File view"><button type="button" className={shownView === "diff" ? "active" : ""} aria-pressed={shownView === "diff"} onClick={() => setView("diff")}>Diff</button><button type="button" className={shownView === "file" ? "active" : ""} aria-pressed={shownView === "file"} disabled={change.status === "deleted"} onClick={() => setView("file")}>Full file</button></div>}{change && <span><b>+{change.additions}</b><i>−{change.deletions}</i></span>}</header>
      {change ? (shownView === "diff" ? <HighlightedDiff change={change} reviews={reviews} store={store} reviewable={!historical} /> : <FullFile change={change} reviews={reviews} browse={browse} store={store} />) : <div className="change-explorer-file-state">{store.loading ? <LoadingState label={historical ? "Loading turn changes" : "Loading changes"} /> : <><strong>{emptyTitle}</strong><span>{emptyDetail}</span></>}</div>}
    </>} sidebar={<><header><div><strong>{historical ? "Turn changes" : "Changed files"}</strong><small>{historical ? `${store.turns.length} ${store.turns.length === 1 ? "turn" : "turns"}` : `${store.changes.length} ${store.changes.length === 1 ? "file" : "files"}`}</small></div><div className="change-explorer-actions">{!historical && pendingCount > 0 && <Button size="sm" onClick={() => void reviews.submitPending()}>Send ({pendingCount})</Button>}<Button variant="ghost" size="sm" onClick={close}>Done</Button></div></header>{historical ? <div className="change-explorer-turn-body"><section className="change-turn-index" aria-label="Conversation turns"><header><strong>Conversation turns</strong><span>{store.turns.length}</span></header>{store.turns.length === 0 ? <p>No recorded changes.</p> : <ol>{store.turns.map((turn) => <li key={turn.id}><button className={turn.id === store.selectedTurnId ? "active" : ""} onClick={() => void store.selectTurn(turn.id)}><span><strong>{turn.label}</strong><small>{new Date(turn.capturedAt).toLocaleString()}</small></span><em>{turn.fileCount} {turn.fileCount === 1 ? "file" : "files"}<small>+{turn.additions} −{turn.deletions}</small></em></button></li>)}</ol>}</section><nav aria-label="Files changed in selected turn"><header><strong>Files in this turn</strong><span>{store.changes.length}</span></header><SourceTree nodes={tree.children} selectedPath={change?.path} onSelect={(path) => store.select(path)} fileMeta={(item) => <small>+{item.additions} −{item.deletions}</small>} /></nav></div> : <div className="change-explorer-sidebar-body"><nav aria-label="Changed files"><SourceTree nodes={tree.children} selectedPath={change?.path} onSelect={(path) => store.select(path)} fileMeta={(item) => <small>+{item.additions} −{item.deletions}</small>} /></nav><section className="review-thread-index" aria-label="Review threads"><header><strong>Comments</strong><span>{changeThreads.length}</span></header>{changeThreads.length === 0 ? <p>No comments yet.</p> : <ol>{indexedThreads.map((thread) => {
      const state = thread.status === "resolved" ? "Resolved" : reviews.threadStreaming(thread.id) ? "Working" : thread.pending ? "Pending" : "Replied";
      return <li key={thread.id}><button className={`${thread.status === "resolved" ? "resolved" : ""} ${reviews.activeThread?.id === thread.id ? "active" : ""}`} onClick={() => focusThread(thread.id)}><i className={state.toLowerCase()} /><span><strong>{reviewThreadPreview(thread, "Review thread")}</strong><small>{threadLocation(thread)}</small></span><em>{state}</em></button></li>;
    })}</ol>}</section></div>}</>} />;
});
