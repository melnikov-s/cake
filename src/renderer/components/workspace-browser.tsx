import { code } from "@streamdown/code";
import { Fragment, useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { observer } from "r-state-tree/react";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { ReviewThreadModel } from "../models/review-thread";
import type { MainChatStore } from "../stores/MainChatStore";
import type { BrowseStore } from "../stores/BrowseStore";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { ReviewComposer, ReviewThreadCard } from "./change-explorer";
import { Button } from "./ui/button";

type HighlightResult = ReturnType<typeof code.highlight>;
type HighlightTokens = NonNullable<HighlightResult>["tokens"];
type HighlightLanguage = Parameters<typeof code.highlight>[0]["language"];

const languages: Record<string, HighlightLanguage> = {
  c: "c", cc: "cpp", cpp: "cpp", css: "css", go: "go", html: "html", java: "java", js: "javascript", jsx: "jsx",
  json: "json", md: "markdown", mdx: "mdx", php: "php", py: "python", rb: "ruby", rs: "rust", scss: "scss", sh: "shellscript",
  sql: "sql", svelte: "svelte", ts: "typescript", tsx: "tsx", vue: "vue", xml: "xml", yaml: "yaml", yml: "yaml"
};

function languageFor(path: string): HighlightLanguage {
  return languages[path.split(".").pop()?.toLowerCase() ?? ""] ?? "markdown";
}

interface TreeNode {
  name: string;
  path: string;
  file: boolean;
  children: Map<string, TreeNode>;
}

function projectTree(files: string[]) {
  const root: TreeNode = { name: "", path: "", file: false, children: new Map() };
  for (const file of files) {
    const names = file.split("/").filter(Boolean);
    let parent = root;
    names.forEach((name, index) => {
      const path = parent.path ? `${parent.path}/${name}` : name;
      let node = parent.children.get(name);
      if (!node) {
        node = { name, path, file: index === names.length - 1, children: new Map() };
        parent.children.set(name, node);
      }
      parent = node;
    });
  }
  return root;
}

function ProjectTree({ nodes, selectedPath, onSelect }: { nodes: Map<string, TreeNode>; selectedPath?: string | null; onSelect(path: string): void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  return <ul>{[...nodes.values()].map((node) => <li key={node.path}>{node.file
    ? <button className={node.path === selectedPath ? "active" : ""} title={node.path} onClick={() => onSelect(node.path)}><span>{node.name}</span></button>
    : <><button className="workspace-tree-directory" aria-expanded={!collapsed.has(node.path)} onClick={() => setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
      return next;
    })}><span className="change-tree-chevron">{collapsed.has(node.path) ? "›" : "⌄"}</span><span>{node.name}</span></button>{!collapsed.has(node.path) && <ProjectTree nodes={node.children} selectedPath={selectedPath} onSelect={onSelect} />}</>}</li>)}</ul>;
}

function elementForNode(node: Node | null) {
  return node instanceof HTMLElement ? node : node?.parentElement ?? null;
}

function selectionColumn(codeElement: HTMLElement, node: Node, offset: number) {
  const range = document.createRange();
  range.selectNodeContents(codeElement);
  try { range.setEnd(node, offset); } catch { return undefined; }
  return Math.max(0, range.toString().length);
}

function sourceAnchor(path: string, lines: string[], startIndex: number, endIndex: number, selectedText: string, startColumn?: number, endColumn?: number): ReviewAnchor {
  return {
    path,
    view: "file",
    start: { diffLine: startIndex, oldLine: startIndex + 1, newLine: startIndex + 1, column: startColumn },
    end: { diffLine: endIndex, oldLine: endIndex + 1, newLine: endIndex + 1, column: endColumn },
    selectedText,
    contextBefore: lines.slice(Math.max(0, startIndex - 3), startIndex).join("\n"),
    contextAfter: lines.slice(endIndex + 1, endIndex + 4).join("\n"),
    diff: ""
  };
}

const SourceFile = observer(function SourceFile({ path, store, reviews }: { path: string; store: BrowseStore; reviews: ReviewsStore }) {
  const [source, setSource] = useState<string>();
  const [tokens, setTokens] = useState<HighlightTokens>();
  const [error, setError] = useState<string>();
  const [composer, setComposer] = useState<{ anchor: ReviewAnchor; floating: boolean; position?: { left: number; top: number } }>();
  const lines = useMemo(() => source?.split("\n") ?? [], [source]);
  const threads = reviews.threads.filter((thread) => thread.anchor.view === "file" && thread.anchor.path === path);

  useEffect(() => {
    let active = true;
    setSource(undefined); setTokens(undefined); setError(undefined); setComposer(undefined);
    void store.readFile(path).then((content) => {
      if (!active) return;
      setSource(content);
      const apply = (result: NonNullable<HighlightResult>) => { if (active) setTokens(result.tokens); };
      const immediate = code.highlight({ code: content, language: languageFor(path), themes: code.getThemes() }, apply);
      if (immediate) apply(immediate);
    }).catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "The file could not be loaded"); });
    return () => { active = false; };
  }, [path, store]);

  const selectText = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, textarea, .review-thread, .review-composer")) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return;
    const firstRow = elementForNode(selection.anchorNode)?.closest<HTMLElement>(".change-explorer-line[data-source-index]");
    const lastRow = elementForNode(selection.focusNode)?.closest<HTMLElement>(".change-explorer-line[data-source-index]");
    if (!firstRow || !lastRow || !event.currentTarget.contains(firstRow) || !event.currentTarget.contains(lastRow)) return;
    const firstIndex = Number(firstRow.dataset.sourceIndex);
    const lastIndex = Number(lastRow.dataset.sourceIndex);
    const forward = firstIndex < lastIndex || (firstIndex === lastIndex && selection.anchorOffset <= selection.focusOffset);
    const startIndex = Math.min(firstIndex, lastIndex);
    const endIndex = Math.max(firstIndex, lastIndex);
    const startNode = forward ? selection.anchorNode : selection.focusNode;
    const endNode = forward ? selection.focusNode : selection.anchorNode;
    const startCode = elementForNode(startNode)?.closest<HTMLElement>("code");
    const endCode = elementForNode(endNode)?.closest<HTMLElement>("code");
    if (!startCode || !endCode) return;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    setComposer({ anchor: sourceAnchor(path, lines, startIndex, endIndex, selection.toString(), selectionColumn(startCode, startNode, forward ? selection.anchorOffset : selection.focusOffset), selectionColumn(endCode, endNode, forward ? selection.focusOffset : selection.anchorOffset)), floating: true, position: { left: Math.min(window.innerWidth - 390, Math.max(16, rect.left)), top: Math.min(window.innerHeight - 250, rect.bottom + 8) } });
  };

  if (error) return <div className="change-explorer-file-state" role="alert"><strong>Unable to show this file</strong><span>{error}</span></div>;
  if (source === undefined) return <div className="change-explorer-file-state"><span>Loading file…</span></div>;
  return <div className="change-explorer-diff change-explorer-full-file workspace-source" role="table" aria-label={`Workspace file ${path}`} onMouseUp={selectText}>{lines.map((line, index) => <Fragment key={index}>
    <div className="change-explorer-line context" data-source-index={index} role="row"><span className="review-gutter"><button aria-label={`Ask about line ${index + 1}`} onClick={() => setComposer({ anchor: sourceAnchor(path, lines, index, index, line, 0, line.length), floating: false })}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" /></svg></button>{index + 1}</span><code><b> </b>{(tokens?.[index] ?? []).length > 0 ? tokens![index]!.map((token, tokenIndex) => <i className="syntax-token" style={token.htmlStyle as CSSProperties} key={`${tokenIndex}-${token.content}`}>{token.content}</i>) : line || " "}</code></div>
    {composer && !composer.floating && composer.anchor.end.diffLine === index && <ReviewComposer anchor={composer.anchor} onSave={(body) => reviews.createThread(composer.anchor, body)} onCancel={() => setComposer(undefined)} />}
    {threads.filter((thread) => thread.anchor.end.diffLine === index).map((thread) => <ReviewThreadCard key={`${thread.id}:${thread.status}`} thread={thread} store={reviews} onFocus={() => { reviews.activeThreadId = thread.id; store.focusPath(thread.anchor.path); }} />)}
  </Fragment>)}{composer?.floating && <ReviewComposer anchor={composer.anchor} floating position={composer.position} onSave={(body) => reviews.createThread(composer.anchor, body)} onCancel={() => setComposer(undefined)} />}</div>;
});

function threadPreview(thread: ReviewThreadModel) {
  const body = thread.messages.find((message) => message.role === "user")?.body ?? "Code question";
  return body.length > 72 ? `${body.slice(0, 72)}…` : body;
}

export const WorkspaceBrowser = observer(function WorkspaceBrowser({ store, reviews, chat, onClose }: { store: BrowseStore; reviews: ReviewsStore; chat: MainChatStore; onClose?: () => void }) {
  const close = onClose ?? (() => store.close());
  const tree = useMemo(() => projectTree(store.files), [store.files]);
  const path = typeof store.path === "string" ? store.path : undefined;
  const threads = reviews.threads.filter((thread) => thread.anchor.view === "file").sort((left, right) => Number(left.status === "resolved") - Number(right.status === "resolved"));
  const pendingCount = reviews.pendingCommentCount;
  return <main className="change-explorer workspace-browser">
    <section className="change-explorer-file"><header><div><small>Project browser · {chat.projectName}</small><h1>{path ?? "Select a file"}</h1></div></header>{path ? <SourceFile path={path} store={store} reviews={reviews} /> : <div className="change-explorer-file-state"><strong>{store.loading ? "Loading project…" : "No files to browse"}</strong><span>{store.loading ? "Building the project tree." : "This project does not contain any visible files."}</span></div>}</section>
    <aside className="change-explorer-tree"><header><div><strong>Project files</strong><small>{store.loading ? "Loading…" : `${store.files.length} files`}</small></div><div className="change-explorer-actions">{pendingCount > 0 && <Button size="sm" onClick={() => void reviews.submitPending()}>Send ({pendingCount})</Button>}<Button variant="ghost" size="sm" onClick={close}>Done</Button></div></header><div className="change-explorer-sidebar-body"><nav aria-label="Project files"><ProjectTree nodes={tree.children} selectedPath={path} onSelect={(file) => store.select(file)} /></nav><section className="review-thread-index" aria-label="Code questions"><header><strong>Questions</strong><span>{threads.length}</span></header>{threads.length === 0 ? <p>Select a line or some code to ask Cake about it.</p> : <ol>{threads.map((thread) => <li key={thread.id}><button className={`${thread.status === "resolved" ? "resolved" : ""} ${reviews.activeThread?.id === thread.id ? "active" : ""}`} onClick={() => { reviews.activeThreadId = thread.id; store.focusPath(thread.anchor.path); }}><i className={thread.status === "resolved" ? "resolved" : thread.pending ? "pending" : "replied"} /><span><strong>{threadPreview(thread)}</strong><small>{thread.anchor.path} · L{thread.anchor.start.newLine ?? thread.anchor.start.oldLine}</small></span><em>{thread.status === "resolved" ? "Resolved" : thread.pending ? "Pending" : "Replied"}</em></button></li>)}</ol>}</section></div></aside>
  </main>;
});
