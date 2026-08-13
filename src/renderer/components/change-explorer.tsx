import { code } from "@streamdown/code";
import { Fragment, useEffect, useMemo, useState, type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { observer } from "r-state-tree/react";
import type { SessionChange } from "../../ipc/session-contract";
import type { ReviewAnchor, ReviewPoint } from "../../ipc/review-contract";
import { parseDiff } from "./ai-elements/diff-view";
import { Button } from "./ui/button";
import type { WindowStore } from "../stores/WindowStore";
import type { ReviewThreadModel } from "../models/review-thread";

type HighlightResult = ReturnType<typeof code.highlight>;
type HighlightTokens = NonNullable<HighlightResult>["tokens"];
type HighlightLanguage = Parameters<typeof code.highlight>[0]["language"];

const languages: Record<string, HighlightLanguage> = {
  c: "c", cc: "cpp", cpp: "cpp", css: "css", go: "go", html: "html", java: "java", js: "javascript", jsx: "jsx",
  json: "json", md: "markdown", mdx: "mdx", php: "php", py: "python", rb: "ruby", rs: "rust", scss: "scss", sh: "shellscript",
  sql: "sql", svelte: "svelte", ts: "typescript", tsx: "tsx", vue: "vue", xml: "xml", yaml: "yaml", yml: "yaml"
};

function languageFor(path: string): HighlightLanguage {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return languages[extension] ?? "markdown";
}

interface FileTreeNode {
  name: string;
  path: string;
  children: Map<string, FileTreeNode>;
  change?: SessionChange;
}

function fileTree(changes: SessionChange[]) {
  const root: FileTreeNode = { name: "", path: "", children: new Map() };
  for (const change of changes) {
    let parent = root;
    for (const [index, name] of change.path.split("/").filter(Boolean).entries()) {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let node = parent.children.get(name);
      if (!node) {
        node = { name, path, children: new Map() };
        parent.children.set(name, node);
      }
      if (index === change.path.split("/").filter(Boolean).length - 1) node.change = change;
      parent = node;
    }
  }
  return root;
}

function ChangeTree({ nodes, selectedPath, onSelect }: { nodes: Map<string, FileTreeNode>; selectedPath: string; onSelect(path: string): void }) {
  return <ul>{[...nodes.values()].map((node) => <li key={node.path}>{node.change
    ? <button className={node.path === selectedPath ? "active" : ""} onClick={() => onSelect(node.path)}><span>{node.name}</span><small>+{node.change.additions} −{node.change.deletions}</small></button>
    : <><div><span className="change-tree-chevron">⌄</span><span>{node.name}</span></div><ChangeTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} /></>}</li>)}</ul>;
}

function reviewPoint(lines: ReturnType<typeof parseDiff>, index: number, column?: number): ReviewPoint {
  const line = lines[index]!;
  return { diffLine: index, oldLine: line.oldNumber, newLine: line.newNumber, column };
}

function reviewAnchor(change: SessionChange, lines: ReturnType<typeof parseDiff>, startIndex: number, endIndex: number, selectedText: string, startColumn?: number, endColumn?: number): ReviewAnchor {
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

function fullFileReviewAnchor(change: SessionChange, lines: string[], startIndex: number, endIndex: number, selectedText: string, startColumn?: number, endColumn?: number): ReviewAnchor {
  return {
    path: change.path,
    view: "full",
    start: { diffLine: startIndex, oldLine: startIndex + 1, newLine: startIndex + 1, column: startColumn },
    end: { diffLine: endIndex, oldLine: endIndex + 1, newLine: endIndex + 1, column: endColumn },
    selectedText,
    contextBefore: lines.slice(Math.max(0, startIndex - 3), startIndex).join("\n"),
    contextAfter: lines.slice(endIndex + 1, endIndex + 4).join("\n"),
    diff: change.diff
  };
}

function elementForNode(node: Node | null) {
  return node instanceof HTMLElement ? node : node?.parentElement ?? null;
}

function selectionColumn(codeElement: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(codeElement);
  try { range.setEnd(node, offset); }
  catch { return undefined; }
  return Math.max(0, range.toString().length - 1);
}

export function ReviewComposer({ anchor, floating, position, onSave, onCancel }: { anchor: ReviewAnchor; floating?: boolean; position?: { left: number; top: number }; onSave(body: string): Promise<unknown>; onCancel(): void }) {
  const [body, setBody] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) return;
    const saved = await onSave(body);
    if (saved === false) return;
    onCancel();
    window.getSelection()?.removeAllRanges();
  };
  const cancel = () => { onCancel(); window.getSelection()?.removeAllRanges(); };
  return <form className={`review-composer ${floating ? "floating" : "inline"}`} style={position} onSubmit={(event) => void submit(event)} onKeyDownCapture={(event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  }}>
    <div><strong>{anchor.start.diffLine === anchor.end.diffLine ? `Comment on line ${anchor.end.newLine ?? anchor.end.oldLine ?? ""}` : `Comment on ${anchor.end.diffLine - anchor.start.diffLine + 1} lines`}</strong><button type="button" aria-label="Cancel comment" onClick={cancel}>×</button></div>
    {anchor.selectedText && <code>{anchor.selectedText.length > 160 ? `${anchor.selectedText.slice(0, 160)}…` : anchor.selectedText}</code>}
    <textarea autoFocus aria-label="Review comment" placeholder="Leave a comment" value={body} onChange={(event) => setBody(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }} />
    <footer><Button type="submit" size="sm" disabled={!body.trim()}>Add comment</Button></footer>
  </form>;
}

export const ReviewThreadCard = observer(function ReviewThreadCard({ thread, store, onFocus }: { thread: ReviewThreadModel; store: WindowStore; onFocus?: () => void }) {
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(thread.status === "open");
  const focus = () => onFocus ? onFocus() : store.focusReviewThread(thread.id);
  if (!expanded) return <button className={`review-thread-resolved ${store.activeReviewThread?.id === thread.id ? "active" : ""}`} data-review-thread-id={thread.id} onClick={() => { focus(); setExpanded(true); }}>✓ Resolved thread · {thread.messages.length} messages</button>;
  return <article className={`review-thread ${thread.status} ${store.activeReviewThread?.id === thread.id ? "active" : ""}`} data-review-thread-id={thread.id} aria-label={`Review thread on ${thread.anchor.path}`} onClick={focus}>
    <header><span><i />{thread.status === "resolved" ? "Resolved" : store.reviewThreadStreaming(thread.id) ? "Working" : thread.pending ? "Pending review" : "Review thread"}</span><div onClick={(event) => event.stopPropagation()}>{thread.status === "resolved" && <button onClick={() => void store.resolveReviewThread(thread.id, false)}>Reopen</button>}<button onClick={() => {
      if (thread.status === "resolved") setExpanded(false);
      else {
        setExpanded(false);
        void store.resolveReviewThread(thread.id);
      }
    }}> {thread.status === "resolved" ? "Minimize" : "Resolve"}</button></div></header>
    <div className="review-thread-messages">{thread.messages.map((message) => <div className={`review-message ${message.role} ${message.status}`} key={message.id}><strong>{message.role === "user" ? "You" : "Cake"}</strong><p>{message.body}</p></div>)}{store.reviewThreadStreaming(thread.id) && <div className="review-message assistant streaming"><strong>Cake</strong><p><span /><span /><span /></p></div>}</div>
    {thread.status === "open" && !thread.pending && !store.reviewThreadStreaming(thread.id) && <form className="review-reply" onSubmit={async (event) => {
      event.preventDefault();
      if (!reply.trim() || replying) return;
      setReplying(true);
      const saved = await store.replyReviewThread(thread.id, reply);
      if (saved) setReply("");
      setReplying(false);
    }}><textarea aria-label="Reply to review thread" placeholder="Reply…" value={reply} disabled={replying} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }} /><Button type="submit" size="sm" disabled={!reply.trim() || replying}>{replying ? "Replying…" : "Reply"}</Button></form>}
  </article>;
});

function threadLocation(thread: ReviewThreadModel) {
  const start = thread.anchor.start.newLine ?? thread.anchor.start.oldLine;
  const end = thread.anchor.end.newLine ?? thread.anchor.end.oldLine;
  return start && end && start !== end ? `${thread.anchor.path} · L${start}–${end}` : start ? `${thread.anchor.path} · L${start}` : thread.anchor.path;
}

function threadPreview(thread: ReviewThreadModel) {
  const body = thread.messages.find((message) => message.role === "user")?.body ?? "Review thread";
  return body.length > 72 ? `${body.slice(0, 72)}…` : body;
}

function scrollToReviewThread(threadId: string) {
  [...document.querySelectorAll<HTMLElement>("[data-review-thread-id]")].find((element) => element.dataset.reviewThreadId === threadId)?.scrollIntoView({ block: "center" });
}

const HighlightedDiff = observer(function HighlightedDiff({ change, store }: { change: SessionChange; store: WindowStore }) {
  const lines = useMemo(() => parseDiff(change.diff), [change.diff]);
  const source = useMemo(() => lines.map((line) => line.kind === "meta" ? "" : line.content).join("\n"), [lines]);
  const [tokens, setTokens] = useState<HighlightTokens>();
  const [composer, setComposer] = useState<{ anchor: ReviewAnchor; floating: boolean; position?: { left: number; top: number } }>();
  const threads = store.reviewThreads.filter((thread) => thread.anchor.view !== "file" && thread.anchor.view !== "full" && thread.anchor.path === change.path);

  useEffect(() => {
    let active = true;
    setTokens(undefined);
    const apply = (result: NonNullable<HighlightResult>) => { if (active) setTokens(result.tokens); };
    const immediate = code.highlight({ code: source, language: languageFor(change.path), themes: code.getThemes() }, apply);
    if (immediate) apply(immediate);
    return () => { active = false; };
  }, [change.path, source]);

  const selectText = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, textarea, .review-thread, .review-composer")) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
    const anchorRow = elementForNode(selection.anchorNode)?.closest<HTMLElement>(".change-explorer-line[data-diff-index]");
    const focusRow = elementForNode(selection.focusNode)?.closest<HTMLElement>(".change-explorer-line[data-diff-index]");
    if (!anchorRow || !focusRow || !event.currentTarget.contains(anchorRow) || !event.currentTarget.contains(focusRow)) return;
    const anchorIndex = Number(anchorRow.dataset.diffIndex);
    const focusIndex = Number(focusRow.dataset.diffIndex);
    const forward = anchorIndex < focusIndex || (anchorIndex === focusIndex && selection.anchorOffset <= selection.focusOffset);
    const startIndex = Math.min(anchorIndex, focusIndex);
    const endIndex = Math.max(anchorIndex, focusIndex);
    const startNode = forward ? selection.anchorNode : selection.focusNode;
    const endNode = forward ? selection.focusNode : selection.anchorNode;
    const startOffset = forward ? selection.anchorOffset : selection.focusOffset;
    const endOffset = forward ? selection.focusOffset : selection.anchorOffset;
    const startCode = elementForNode(startNode)?.closest<HTMLElement>("code");
    const endCode = elementForNode(endNode)?.closest<HTMLElement>("code");
    if (!startCode || !endCode) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setComposer({ anchor: reviewAnchor(change, lines, startIndex, endIndex, selection.toString(), startCode ? selectionColumn(startCode, startNode, startOffset) : undefined, endCode ? selectionColumn(endCode, endNode, endOffset) : undefined), floating: true, position: { left: Math.min(window.innerWidth - 390, Math.max(16, rect.left)), top: Math.min(window.innerHeight - 250, rect.bottom + 8) } });
  };

  return <div className="change-explorer-diff" role="table" aria-label={`Full session changes to ${change.path}`} onMouseUp={selectText}>{lines.map((line, index) => line.kind === "meta"
    ? <div className="change-explorer-line meta" role="row" key={line.key}><span /><span /><code>{line.content}</code></div>
    : <Fragment key={line.key}><div className={`change-explorer-line ${line.kind}`} data-diff-index={index} role="row">
        <span className="review-gutter"><button aria-label={`Comment on line ${line.newNumber ?? line.oldNumber}`} onClick={() => setComposer({ anchor: reviewAnchor(change, lines, index, index, line.content, 0, line.content.length), floating: false })}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" /></svg></button>{line.oldNumber}</span><span>{line.newNumber}</span><code><b>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</b>{(tokens?.[index] ?? []).length > 0
          ? tokens![index]!.map((token, tokenIndex) => <i className="syntax-token" style={token.htmlStyle as CSSProperties} key={`${tokenIndex}-${token.content}`}>{token.content}</i>)
          : line.content || " "}</code>
      </div>{composer && !composer.floating && composer.anchor.end.diffLine === index && <ReviewComposer anchor={composer.anchor} onSave={(body) => store.createReviewThread(composer.anchor, body)} onCancel={() => setComposer(undefined)} />}{threads.filter((thread) => thread.anchor.end.diffLine === index).map((thread) => <ReviewThreadCard key={`${thread.id}:${thread.status}`} thread={thread} store={store} />)}</Fragment>)}
    {composer?.floating && <ReviewComposer anchor={composer.anchor} floating position={composer.position} onSave={(body) => store.createReviewThread(composer.anchor, body)} onCancel={() => { setComposer(undefined); window.getSelection()?.removeAllRanges(); }} />}</div>;
});

function FullFile({ change, store }: { change: SessionChange; store: WindowStore }) {
  const [source, setSource] = useState<string>();
  const [tokens, setTokens] = useState<HighlightTokens>();
  const [error, setError] = useState<string>();
  const [composer, setComposer] = useState<{ anchor: ReviewAnchor; floating: boolean; position?: { left: number; top: number } }>();

  useEffect(() => {
    let active = true;
    setSource(undefined);
    setTokens(undefined);
    setError(undefined);
    setComposer(undefined);
    void store.readWorkspaceFile(change.path).then((content) => {
      if (!active) return;
      setSource(content);
      const apply = (result: NonNullable<HighlightResult>) => { if (active) setTokens(result.tokens); };
      const immediate = code.highlight({ code: content, language: languageFor(change.path), themes: code.getThemes() }, apply);
      if (immediate) apply(immediate);
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "The file could not be loaded");
    });
    return () => { active = false; };
  }, [change.path, store]);

  if (error) return <div className="change-explorer-file-state" role="alert"><strong>Unable to show the full file</strong><span>{error}</span></div>;
  if (source === undefined) return <div className="change-explorer-file-state"><span>Loading full file…</span></div>;
  const sourceLines = source.split("\n");
  const threads = store.reviewThreads.filter((thread) => thread.anchor.view === "full" && thread.anchor.path === change.path);
  const selectText = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, textarea, .review-thread, .review-composer")) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
    const anchorRow = elementForNode(selection.anchorNode)?.closest<HTMLElement>(".change-explorer-line[data-source-index]");
    const focusRow = elementForNode(selection.focusNode)?.closest<HTMLElement>(".change-explorer-line[data-source-index]");
    if (!anchorRow || !focusRow || !event.currentTarget.contains(anchorRow) || !event.currentTarget.contains(focusRow)) return;
    const anchorIndex = Number(anchorRow.dataset.sourceIndex);
    const focusIndex = Number(focusRow.dataset.sourceIndex);
    const forward = anchorIndex < focusIndex || (anchorIndex === focusIndex && selection.anchorOffset <= selection.focusOffset);
    const startIndex = Math.min(anchorIndex, focusIndex);
    const endIndex = Math.max(anchorIndex, focusIndex);
    const startNode = forward ? selection.anchorNode : selection.focusNode;
    const endNode = forward ? selection.focusNode : selection.anchorNode;
    const startCode = elementForNode(startNode)?.closest<HTMLElement>("code");
    const endCode = elementForNode(endNode)?.closest<HTMLElement>("code");
    if (!startCode || !endCode) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setComposer({
      anchor: fullFileReviewAnchor(change, sourceLines, startIndex, endIndex, selection.toString(), selectionColumn(startCode, startNode, forward ? selection.anchorOffset : selection.focusOffset), selectionColumn(endCode, endNode, forward ? selection.focusOffset : selection.anchorOffset)),
      floating: true,
      position: { left: Math.min(window.innerWidth - 390, Math.max(16, rect.left)), top: Math.min(window.innerHeight - 250, rect.bottom + 8) }
    });
  };
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
  return <div className="change-explorer-diff change-explorer-full-file" role="table" aria-label={`Full file ${change.path}`} onMouseUp={selectText}>{sourceLines.map((line, index) => {
    const lineNumber = index + 1;
    const added = addedLines.has(lineNumber);
    return <Fragment key={lineNumber}>{removedRows(lineNumber)}<div className={`change-explorer-line ${added ? "add" : "context"}`} data-source-index={index} role="row">
      <span className="review-gutter"><button aria-label={`Comment on line ${lineNumber}`} onClick={() => setComposer({ anchor: fullFileReviewAnchor(change, sourceLines, index, index, line, 0, line.length), floating: false })}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" /></svg></button>{lineNumber}</span><code><b>{added ? "+" : " "}</b>{(tokens?.[index] ?? []).length > 0
        ? tokens![index]!.map((token, tokenIndex) => <i className="syntax-token" style={token.htmlStyle as CSSProperties} key={`${tokenIndex}-${token.content}`}>{token.content}</i>)
        : line || " "}</code>
    </div>{composer && !composer.floating && composer.anchor.end.diffLine === index && <ReviewComposer anchor={composer.anchor} onSave={(body) => store.createReviewThread(composer.anchor, body)} onCancel={() => setComposer(undefined)} />}{threads.filter((thread) => thread.anchor.end.diffLine === index).map((thread) => <ReviewThreadCard key={`${thread.id}:${thread.status}`} thread={thread} store={store} />)}</Fragment>;
  })}{removedRows(sourceLines.length + 1)}{composer?.floating && <ReviewComposer anchor={composer.anchor} floating position={composer.position} onSave={(body) => store.createReviewThread(composer.anchor, body)} onCancel={() => setComposer(undefined)} />}</div>;
}

export const ChangeExplorer = observer(function ChangeExplorer({ store }: { store: WindowStore }) {
  const [view, setView] = useState<"diff" | "file">("diff");
  const change = store.selectedSessionChange;
  const tree = useMemo(() => fileTree(store.sessionChanges), [store.sessionChanges]);
  const changeThreads = store.reviewThreads.filter((thread) => thread.anchor.view !== "file");
  const indexedThreads = [...changeThreads].sort((left, right) => Number(left.status === "resolved") - Number(right.status === "resolved"));
  const activeChangeThread = changeThreads.find((thread) => thread.id === store.activeReviewThreadId);
  const pendingCount = store.pendingReviewCommentCount ?? store.pendingReviewThreads?.length ?? 0;
  const focusThread = (threadId: string) => {
    const thread = changeThreads.find((item) => item.id === threadId);
    if (thread) setView(thread.anchor.view === "full" ? "file" : "diff");
    store.focusReviewThread(threadId);
    requestAnimationFrame(() => scrollToReviewThread(threadId));
  };
  useEffect(() => {
    if (!activeChangeThread) return;
    setView(activeChangeThread.anchor.view === "full" ? "file" : "diff");
    scrollToReviewThread(activeChangeThread.id);
  }, [change?.path, activeChangeThread?.id, activeChangeThread?.anchor.view]);
  if (!change) return <main className="change-explorer-empty"><div><small>{store.sessionTitle}</small><h1>No session changes</h1><p>This session has no recorded file diffs.</p><Button variant="outline" onClick={() => store.closeChangeExplorer()}>Return to chat</Button></div></main>;
  return <main className="change-explorer">
    <section className="change-explorer-file">
      <header><div><small>Session changes · {store.sessionTitle}</small><h1>{change.path}</h1></div><div className="change-explorer-view-toggle" role="group" aria-label="File view"><button type="button" className={view === "diff" ? "active" : ""} aria-pressed={view === "diff"} onClick={() => setView("diff")}>Diff</button><button type="button" className={view === "file" ? "active" : ""} aria-pressed={view === "file"} onClick={() => setView("file")}>Full file</button></div><span><b>+{change.additions}</b><i>−{change.deletions}</i></span></header>
      {view === "diff" ? <HighlightedDiff change={change} store={store} /> : <FullFile change={change} store={store} />}
    </section>
    <aside className="change-explorer-tree"><header><div><strong>Changed files</strong><small>{store.sessionChanges.length} {store.sessionChanges.length === 1 ? "file" : "files"}</small></div><div className="change-explorer-actions">{pendingCount > 0 && <Button size="sm" onClick={() => void store.sendPendingReviewComments()}>Send ({pendingCount})</Button>}<Button variant="ghost" size="sm" onClick={() => store.closeChangeExplorer()}>Done</Button></div></header><div className="change-explorer-sidebar-body"><nav aria-label="Changed files"><ChangeTree nodes={tree.children} selectedPath={change.path} onSelect={(path) => store.selectChangeExplorerFile(path)} /></nav><section className="review-thread-index" aria-label="Review threads"><header><strong>Comments</strong><span>{changeThreads.length}</span></header>{changeThreads.length === 0 ? <p>No comments yet.</p> : <ol>{indexedThreads.map((thread) => {
      const state = thread.status === "resolved" ? "Resolved" : store.reviewThreadStreaming(thread.id) ? "Working" : thread.pending ? "Pending" : "Replied";
      return <li key={thread.id}><button className={`${thread.status === "resolved" ? "resolved" : ""} ${store.activeReviewThread?.id === thread.id ? "active" : ""}`} onClick={() => focusThread(thread.id)}><i className={state.toLowerCase()} /><span><strong>{threadPreview(thread)}</strong><small>{threadLocation(thread)}</small></span><em>{state}</em></button></li>;
    })}</ol>}</section></div></aside>
  </main>;
});
