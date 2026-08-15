import { useMemo } from "react";
import { observer } from "r-state-tree/react";
import type { MainChatStore } from "../stores/MainChatStore";
import type { BrowseStore } from "../stores/BrowseStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { Button } from "./ui/button";
import { SourceReview, reviewThreadPreview, useFileContent } from "./source-review";
import { SourceExplorerLayout, SourceTree, sourceTree } from "./source-explorer";

const SourceFile = observer(function SourceFile({ path, store, reviews }: { path: string; store: BrowseStore; reviews: ReviewsStore }) {
  const readFile = useMemo(() => (sourcePath: string) => store.readFile(sourcePath), [store]);
  const content = useFileContent(path, readFile);
  const threads = reviews.threads.filter((thread) => thread.anchor.view === "file" && thread.anchor.path === path);
  if (content.error) return <div className="change-explorer-file-state" role="alert"><strong>Unable to show this file</strong><span>{content.error}</span></div>;
  if (content.source === undefined) return <div className="change-explorer-file-state"><span>Loading file…</span></div>;
  return <SourceReview path={path} view="file" lines={content.source.split("\n")} tokens={content.tokens} diff="" reviews={reviews} threads={threads} ariaLabel={`Workspace file ${path}`} className="workspace-source" actionLabel="Ask about" onFocusThread={(thread) => { reviews.activeThreadId = thread.id; store.focusPath(thread.anchor.path); }} />;
});

export const WorkspaceBrowser = observer(function WorkspaceBrowser({ store, reviews, chat, onClose }: { store: BrowseStore; reviews: ReviewsStore; chat: MainChatStore; onClose?: () => void }) {
  const close = onClose ?? (() => store.close());
  const tree = sourceTree(store.files, (file) => file);
  const path = typeof store.path === "string" ? store.path : undefined;
  const threads = reviews.threads.filter((thread) => thread.anchor.view === "file").sort((left, right) => Number(left.status === "resolved") - Number(right.status === "resolved"));
  const pendingCount = reviews.pendingCommentCount;
  return <SourceExplorerLayout className="workspace-browser" resizeLabel="Resize project files panel" file={<><header><div><small>Project browser · {chat.projectName}</small><h1>{path ?? "Select a file"}</h1></div></header>{path ? <SourceFile path={path} store={store} reviews={reviews} /> : <div className="change-explorer-file-state"><strong>{store.loading ? "Loading project…" : "No files to browse"}</strong><span>{store.loading ? "Building the project tree." : "This project does not contain any visible files."}</span></div>}</>} sidebar={<><header><div><strong>Project files</strong><small>{store.loading ? "Loading…" : `${store.files.length} files`}</small></div><div className="change-explorer-actions">{pendingCount > 0 && <Button size="sm" onClick={() => void reviews.submitPending()}>Send ({pendingCount})</Button>}<Button variant="ghost" size="sm" onClick={close}>Done</Button></div></header><div className="change-explorer-sidebar-body"><nav aria-label="Project files"><SourceTree nodes={tree.children} selectedPath={path} onSelect={(file) => store.select(file)} collapsible /></nav><section className="review-thread-index" aria-label="Code questions"><header><strong>Questions</strong><span>{threads.length}</span></header>{threads.length === 0 ? <p>Select a line or some code to ask Cake about it.</p> : <ol>{threads.map((thread) => <li key={thread.id}><button className={`${thread.status === "resolved" ? "resolved" : ""} ${reviews.activeThread?.id === thread.id ? "active" : ""}`} onClick={() => { reviews.activeThreadId = thread.id; store.focusPath(thread.anchor.path); }}><i className={thread.status === "resolved" ? "resolved" : thread.pending ? "pending" : "replied"} /><span><strong>{reviewThreadPreview(thread, "Code question")}</strong><small>{thread.anchor.path} · L{thread.anchor.start.newLine ?? thread.anchor.start.oldLine}</small></span><em>{thread.status === "resolved" ? "Resolved" : thread.pending ? "Pending" : "Replied"}</em></button></li>)}</ol>}</section></div></>} />;
});
