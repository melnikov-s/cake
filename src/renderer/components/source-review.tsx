import { code } from "@streamdown/code";
import { Fragment, useEffect, useState, type CSSProperties, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import type { ReviewAnchor } from "../../ipc/review-contract";
import type { ReviewThreadModel } from "../models/review-thread";
import type { ReviewsStore } from "../stores/ReviewsStore";
import { Button } from "./ui/button";
import { extractSourceSelection } from "./source-selection";
export { selectionColumn } from "./source-selection";

type HighlightResult = ReturnType<typeof code.highlight>;
export type HighlightTokens = NonNullable<HighlightResult>["tokens"];
type HighlightLanguage = Parameters<typeof code.highlight>[0]["language"];

const languages: Record<string, HighlightLanguage> = {
  c: "c", cc: "cpp", cpp: "cpp", css: "css", go: "go", html: "html", java: "java", js: "javascript", jsx: "jsx",
  json: "json", md: "markdown", mdx: "mdx", php: "php", py: "python", rb: "ruby", rs: "rust", scss: "scss", sh: "shellscript",
  sql: "sql", svelte: "svelte", ts: "typescript", tsx: "tsx", vue: "vue", xml: "xml", yaml: "yaml", yml: "yaml"
};

export function languageForSource(path: string): HighlightLanguage {
  return languages[path.split(".").pop()?.toLowerCase() ?? ""] ?? "markdown";
}

function highlightSource(path: string, source: string, apply: (tokens: HighlightTokens) => void) {
  const accept = (result: NonNullable<HighlightResult>) => apply(result.tokens);
  const immediate = code.highlight({ code: source, language: languageForSource(path), themes: code.getThemes() }, accept);
  if (immediate) accept(immediate);
}

export function useHighlightedSource(path: string, source: string) {
  const [tokens, setTokens] = useState<HighlightTokens>();
  useEffect(() => {
    let active = true;
    setTokens(undefined);
    highlightSource(path, source, (next) => { if (active) setTokens(next); });
    return () => { active = false; };
  }, [path, source]);
  return tokens;
}

export function useFileContent(path: string, readFile: (path: string) => Promise<string>) {
  const [state, setState] = useState<{ path: string; source?: string; tokens?: HighlightTokens; error?: string }>({ path });
  useEffect(() => {
    let active = true;
    setState({ path });
    void readFile(path).then((source) => {
      if (!active) return;
      setState({ path, source });
      highlightSource(path, source, (tokens) => { if (active) setState({ path, source, tokens }); });
    }).catch((reason: unknown) => {
      if (active) setState({ path, error: reason instanceof Error ? reason.message : "The file could not be loaded" });
    });
    return () => { active = false; };
  }, [path, readFile]);
  return state.path === path ? state : { path };
}

function sourceAnchor(path: string, view: "full" | "file", lines: string[], diff: string, startIndex: number, endIndex: number, selectedText: string, startColumn?: number, endColumn?: number): ReviewAnchor {
  return {
    path,
    view,
    start: { diffLine: startIndex, oldLine: startIndex + 1, newLine: startIndex + 1, column: startColumn },
    end: { diffLine: endIndex, oldLine: endIndex + 1, newLine: endIndex + 1, column: endColumn },
    selectedText,
    contextBefore: lines.slice(Math.max(0, startIndex - 3), startIndex).join("\n"),
    contextAfter: lines.slice(endIndex + 1, endIndex + 4).join("\n"),
    diff
  };
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

export const ReviewThreadCard = observer(function ReviewThreadCard({ thread, store, onFocus }: { thread: ReviewThreadModel; store: ReviewsStore; onFocus?: () => void }) {
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const [expanded, setExpanded] = useState(thread.status === "open");
  const focus = () => onFocus ? onFocus() : store.activeThreadId = thread.id;
  if (!expanded) return <button className={`review-thread-resolved ${store.activeThread?.id === thread.id ? "active" : ""}`} data-review-thread-id={thread.id} onClick={() => { focus(); setExpanded(true); }}>✓ Resolved thread · {thread.messages.length} messages</button>;
  return <article className={`review-thread ${thread.status} ${store.activeThread?.id === thread.id ? "active" : ""}`} data-review-thread-id={thread.id} aria-label={`Review thread on ${thread.anchor.path}`} onClick={focus}>
    <header><span><i />{thread.status === "resolved" ? "Resolved" : store.threadStreaming(thread.id) ? "Working" : thread.pending ? "Pending review" : "Review thread"}</span><div onClick={(event) => event.stopPropagation()}>{thread.status === "resolved" && <button onClick={() => void store.resolveThread(thread.id, false)}>Reopen</button>}<button onClick={() => {
      if (thread.status === "resolved") setExpanded(false);
      else { setExpanded(false); void store.resolveThread(thread.id); }
    }}> {thread.status === "resolved" ? "Minimize" : "Resolve"}</button></div></header>
    <div className="review-thread-messages">{thread.messages.map((message) => <div className={`review-message ${message.role} ${message.status}`} key={message.id}><strong>{message.role === "user" ? "You" : "Cake"}</strong><p>{message.body}</p></div>)}{store.threadStreaming(thread.id) && <div className="review-message assistant streaming"><strong>Cake</strong><p><span /><span /><span /></p></div>}</div>
    {thread.status === "open" && !thread.pending && !store.threadStreaming(thread.id) && <form className="review-reply" onSubmit={async (event) => {
      event.preventDefault();
      if (!reply.trim() || replying) return;
      setReplying(true);
      const saved = await store.replyThread(thread.id, reply);
      if (saved) setReply("");
      setReplying(false);
    }}><textarea aria-label="Reply to review thread" placeholder="Reply…" value={reply} disabled={replying} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => {
      if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }} /><Button type="submit" size="sm" disabled={!reply.trim() || replying}>{replying ? "Replying…" : "Reply"}</Button></form>}
  </article>;
});

interface SourceReviewProps {
  path: string;
  view: "full" | "file";
  lines: string[];
  tokens?: HighlightTokens;
  diff: string;
  reviews: ReviewsStore;
  threads: ReviewThreadModel[];
  ariaLabel: string;
  className?: string;
  actionLabel?: string;
  lineClass?(line: string, index: number): string;
  prefix?(line: string, index: number): ReactNode;
  beforeLine?(index: number): ReactNode;
  afterLines?: ReactNode;
  onFocusThread?(thread: ReviewThreadModel): void;
}

export const SourceReview = observer(function SourceReview({ path, view, lines, tokens, diff, reviews, threads, ariaLabel, className = "", actionLabel = "Comment on", lineClass, prefix, beforeLine, afterLines, onFocusThread }: SourceReviewProps) {
  const [composer, setComposer] = useState<{ anchor: ReviewAnchor; floating: boolean; position?: { left: number; top: number } }>();
  useEffect(() => setComposer(undefined), [path, view]);
  const makeAnchor = (startIndex: number, endIndex: number, selectedText: string, startColumn?: number, endColumn?: number) => sourceAnchor(path, view, lines, diff, startIndex, endIndex, selectedText, startColumn, endColumn);
  const selectText = (event: ReactMouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button, textarea, .review-thread, .review-composer")) return;
    const selected = extractSourceSelection(event.currentTarget, ".change-explorer-line[data-source-index]", "data-source-index");
    if (!selected) return;
    setComposer({
      anchor: makeAnchor(selected.startIndex, selected.endIndex, selected.selectedText, selected.startColumn, selected.endColumn),
      floating: true,
      position: selected.position
    });
  };
  return <div className={`change-explorer-diff change-explorer-full-file ${className}`.trim()} role="table" aria-label={ariaLabel} onMouseUp={selectText}>{lines.map((line, index) => <Fragment key={index}>
    {beforeLine?.(index)}
    <div className={`change-explorer-line ${lineClass?.(line, index) ?? "context"}`} data-source-index={index} role="row"><span className="review-gutter"><button aria-label={`${actionLabel} line ${index + 1}`} onClick={() => setComposer({ anchor: makeAnchor(index, index, line, 0, line.length), floating: false })}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" /></svg></button>{index + 1}</span><code><b data-review-prefix>{prefix?.(line, index) ?? " "}</b>{(tokens?.[index] ?? []).length > 0 ? tokens![index]!.map((token, tokenIndex) => <i className="syntax-token" style={token.htmlStyle as CSSProperties} key={`${tokenIndex}-${token.content}`}>{token.content}</i>) : line || " "}</code></div>
    {composer && !composer.floating && composer.anchor.end.diffLine === index && <ReviewComposer anchor={composer.anchor} onSave={(body) => reviews.createThread(composer.anchor, body)} onCancel={() => setComposer(undefined)} />}
    {threads.filter((thread) => thread.anchor.end.diffLine === index).map((thread) => <ReviewThreadCard key={`${thread.id}:${thread.status}`} thread={thread} store={reviews} onFocus={onFocusThread ? () => onFocusThread(thread) : undefined} />)}
  </Fragment>)}{afterLines}{composer?.floating && <ReviewComposer anchor={composer.anchor} floating position={composer.position} onSave={(body) => reviews.createThread(composer.anchor, body)} onCancel={() => setComposer(undefined)} />}</div>;
});

export function reviewThreadPreview(thread: ReviewThreadModel, fallback: string) {
  const body = thread.messages.find((message) => message.role === "user")?.body ?? fallback;
  return body.length > 72 ? `${body.slice(0, 72)}…` : body;
}
