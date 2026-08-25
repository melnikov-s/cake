import { useMemo } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectWorkbenchStore } from "../stores/ProjectWorkbenchStore";
import type { BrowseStore } from "../stores/BrowseStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { Button } from "./ui/button";
import { LoadingState } from "./ui/loading-state";
import { EmbeddedEditorPane } from "./embedded-editor";
import { SourceReview, reviewThreadPreview, useFileContent } from "./source-review";
import { SourceExplorerLayout, SourceTree, sourceTree } from "./source-explorer";

const SourceFile = observer(function SourceFile({
  path,
  store,
  reviews,
}: {
  path: string;
  store: BrowseStore;
  reviews: ReviewsStore;
}) {
  const readFile = useMemo(() => (sourcePath: string) => store.readFile(sourcePath), [store]);
  const content = useFileContent(path, readFile);
  const threads = reviews.threads.filter(
    (thread) => thread.anchor.view === "file" && thread.anchor.path === path,
  );
  if (content.error)
    return (
      <div className="change-explorer-file-state" role="alert">
        <strong>Unable to show this file</strong>
        <span>{content.error}</span>
      </div>
    );
  if (content.source === undefined)
    return (
      <div className="change-explorer-file-state">
        <LoadingState label="Loading file" />
      </div>
    );
  return (
    <SourceReview
      path={path}
      view="file"
      lines={content.source.split("\n")}
      tokens={content.tokens}
      diff=""
      reviews={reviews}
      threads={threads}
      ariaLabel={`Workspace file ${path}`}
      className="workspace-source"
      actionLabel="Ask about"
      onFocusThread={(thread) => {
        reviews.selectThread(thread.id);
        store.focusPath(thread.anchor.path);
      }}
    />
  );
});

export const WorkspaceBrowser = observer(function WorkspaceBrowser({
  store,
  reviews,
  chat,
  onClose,
}: {
  store: BrowseStore;
  reviews: ReviewsStore;
  chat: ProjectWorkbenchStore;
  onClose?: () => void;
}) {
  const close = onClose ?? (() => store.close());
  const embedded = chat.embeddedEditorStore;
  const vscodeMode = embedded.mode === "vscode";
  const tree = sourceTree(store.files, (file) => file);
  const path = store.path ?? undefined;
  const threads = reviews.threads
    .filter((thread) => thread.anchor.view === "file")
    .sort(
      (left, right) => Number(left.status === "resolved") - Number(right.status === "resolved"),
    );
  return (
    <SourceExplorerLayout
      className="workspace-browser"
      resizeLabel="Resize project files panel"
      file={
        <>
          <header>
            <div>
              <small>Project browser · {chat.projectName}</small>
              <h1>{path ?? "Select a file"}</h1>
              {vscodeMode && embedded.lastActivePath ? (
                <small>VS Code is viewing {embedded.lastActivePath}</small>
              ) : null}
            </div>
            <div className="workspace-browser-header-actions">
              <div className="change-explorer-view-toggle" role="group" aria-label="Browser mode">
                <button
                  type="button"
                  className={vscodeMode ? "" : "active"}
                  aria-pressed={!vscodeMode}
                  onClick={() => embedded.setMode("builtin")}
                >
                  Reader
                </button>
                <button
                  type="button"
                  className={vscodeMode ? "active" : ""}
                  aria-pressed={vscodeMode}
                  onClick={() => embedded.setMode("vscode")}
                >
                  VS Code
                </button>
              </div>
              {vscodeMode ? (
                <Button variant="ghost" size="sm" onClick={close}>
                  Back to Cake
                </Button>
              ) : null}
            </div>
          </header>
          {vscodeMode ? (
            <EmbeddedEditorPane store={embedded} />
          ) : path ? (
            <SourceFile path={path} store={store} reviews={reviews} />
          ) : (
            <div className="change-explorer-file-state">
              {store.loading ? (
                <LoadingState label="Loading project" />
              ) : (
                <>
                  <strong>{store.error ? "Unable to load project" : "No files to browse"}</strong>
                  <span>{store.error ?? "This project does not contain any visible files."}</span>
                </>
              )}
            </div>
          )}
        </>
      }
      sidebar={
        vscodeMode ? undefined : (
          <>
            <header>
              <div>
                <strong>Project files</strong>
                <small>{store.loading ? "Loading" : `${store.files.length} files`}</small>
              </div>
              <div className="change-explorer-actions">
                <Button variant="ghost" size="sm" onClick={close}>
                  Done
                </Button>
              </div>
            </header>
            <div className="change-explorer-sidebar-body">
              <nav aria-label="Project files">
                <SourceTree
                  nodes={tree.children}
                  selectedPath={path}
                  onSelect={(file) => {
                    store.select(file);
                    if (vscodeMode) void embedded.reveal(file);
                  }}
                  collapsible
                />
              </nav>
              <section className="review-thread-index" aria-label="Code questions">
                <header>
                  <strong>Questions</strong>
                  <span>{threads.length}</span>
                </header>
                {threads.length === 0 ? (
                  <p>Select a line or some code to ask Cake about it.</p>
                ) : (
                  <ol>
                    {threads.map((thread) => (
                      <li key={thread.id}>
                        <button
                          className={`${thread.status === "resolved" ? "resolved" : ""} ${reviews.activeThread?.id === thread.id ? "active" : ""}`}
                          onClick={() => {
                            reviews.selectThread(thread.id);
                            store.focusPath(thread.anchor.path);
                          }}
                        >
                          <i
                            className={
                              thread.status === "resolved"
                                ? "resolved"
                                : thread.pending
                                  ? "pending"
                                  : "replied"
                            }
                          />
                          <span>
                            <strong>{reviewThreadPreview(thread, "Code question")}</strong>
                            <small>
                              {thread.anchor.path} · L
                              {thread.anchor.start.newLine ?? thread.anchor.start.oldLine}
                            </small>
                          </span>
                          <em>
                            {thread.status === "resolved"
                              ? "Resolved"
                              : thread.pending
                                ? "Pending"
                                : "Replied"}
                          </em>
                        </button>
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </div>
          </>
        )
      }
    />
  );
});
