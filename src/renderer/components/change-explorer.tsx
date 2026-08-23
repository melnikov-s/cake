import { useEffect, useRef, useState, type CSSProperties } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "./ui/button";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { ChangesStore } from "../stores/ChangesStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import type { BrowseStore } from "../stores/BrowseStore";
import { reviewThreadPreview } from "./source-review";
import { SourceExplorerLayout, SourceTree, sourceTree } from "./source-explorer";
import { PanelResizeHandle } from "./panel-resize-handle";
import { LoadingState } from "./ui/loading-state";
import { FullDiff } from "./full-diff";
import { FullFile } from "./full-file";

function threadLocation(thread: ReviewsStore["threads"][number]) {
  const start = thread.anchor.start.newLine ?? thread.anchor.start.oldLine;
  const end = thread.anchor.end.newLine ?? thread.anchor.end.oldLine;
  return start && end && start !== end
    ? `${thread.anchor.path} · L${start}–${end}`
    : start
      ? `${thread.anchor.path} · L${start}`
      : thread.anchor.path;
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
  const [scrollRequest, setScrollRequest] = useState<{ path: string; revision: number }>();
  const scrollRevision = useRef(0);
  const historical = store.source === "conversation-turn";
  const viewChanges = store.visibleChanges ?? store.changes;
  const turns = store.turns ?? [];
  const change = store.selected;
  const tree = sourceTree(viewChanges, (item) => item.path);
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
  const shownView = historical || change?.status === "deleted" ? "diff" : view;
  const selectFile = (path: string) => {
    store.select(path);
    setScrollRequest({ path, revision: ++scrollRevision.current });
  };
  const focusThread = (threadId: string) => {
    const thread = changeThreads.find((item) => item.id === threadId);
    if (thread) setView(thread.anchor.view === "full" ? "file" : "diff");
    reviews.selectThread(threadId);
    store.focusPath(thread!.anchor.path);
  };
  useEffect(() => {
    if (!activeChangeThread || historical) return;
    setView(activeChangeThread.anchor.view === "full" ? "file" : "diff");
  }, [change?.path, activeChangeThread?.id, activeChangeThread?.anchor.view, historical]);
  const context = historical
    ? `Work log · ${chat.sessionTitle}`
    : `Working tree · staged, unstaged, and untracked · ${chat.sessionTitle}`;
  const totalAdditions = viewChanges.reduce((total, item) => total + item.additions, 0);
  const totalDeletions = viewChanges.reduce((total, item) => total + item.deletions, 0);
  const emptyTitle = store.error
    ? "Unable to inspect changes"
    : store.loading
      ? "Loading changes…"
      : historical
        ? "No recorded work-log changes"
        : "Working tree is clean";
  const emptyDetail =
    store.error ??
    (store.loading
      ? historical
        ? "Reading file diffs from the session work log."
        : "Reading the current Git working tree."
      : historical
        ? "No edit diffs were recorded for this session."
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
            <label className="change-explorer-source">
              <span>Show</span>
              <select
                aria-label="Change source"
                value={store.source ?? "working-tree"}
                onChange={(event) => {
                  setScrollRequest(undefined);
                  void store.selectSource(
                    event.target.value === "conversation-turn"
                      ? "conversation-turn"
                      : "working-tree",
                  );
                }}
              >
                <option value="working-tree">Working tree</option>
                <option value="conversation-turn">Work log</option>
              </select>
            </label>
            {change && !historical && (
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
            {viewChanges.length > 0 && (
              <span>
                <b>+{totalAdditions}</b>
                <i>−{totalDeletions}</i>
              </span>
            )}
          </header>
          {change ? (
            shownView === "diff" ? (
              <FullDiff
                changes={viewChanges}
                reviews={reviews}
                store={store}
                reviewable={!historical}
                scrollRequest={scrollRequest}
              />
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
              <strong>{historical ? "Work log" : "Changed files"}</strong>
              <small>
                {historical
                  ? `${turns.length} ${turns.length === 1 ? "turn" : "turns"}`
                  : `${viewChanges.length} ${viewChanges.length === 1 ? "file" : "files"}`}
              </small>
            </div>
            <div className="change-explorer-actions">
              <Button variant="ghost" size="sm" onClick={close}>
                Done
              </Button>
            </div>
          </header>
          {historical ? (
            <div className="change-explorer-turn-body">
              <section className="change-turn-index" aria-label="Work log turns">
                <header>
                  <strong>Work log turns</strong>
                  <span>{turns.length}</span>
                </header>
                {turns.length === 0 ? (
                  <p>No edit diffs recorded.</p>
                ) : (
                  <ol>
                    {turns.map((turn) => (
                      <li key={turn.id}>
                        <button
                          className={turn.id === store.selectedTurnId ? "active" : ""}
                          onClick={() => store.selectTurn(turn.id)}
                        >
                          <span>
                            <strong>{turn.label}</strong>
                            <small>{turn.changes.length} changed files</small>
                          </span>
                          <em>
                            +{turn.additions} −{turn.deletions}
                          </em>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
              <nav aria-label="Files changed in selected work-log turn">
                <header>
                  <strong>Files in this turn</strong>
                  <span>{viewChanges.length}</span>
                </header>
                <SourceTree
                  nodes={tree.children}
                  selectedPath={change?.path}
                  onSelect={selectFile}
                  fileMeta={(item) => (
                    <small>
                      +{item.additions} −{item.deletions}
                    </small>
                  )}
                />
              </nav>
            </div>
          ) : (
            <div
              className={`change-explorer-sidebar-body ${resizingComments ? "is-resizing" : ""}`}
              style={sidebarStyle}
            >
              <nav aria-label="Changed files">
                <SourceTree
                  nodes={tree.children}
                  selectedPath={change?.path}
                  onSelect={selectFile}
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
          )}
        </>
      }
    />
  );
});
