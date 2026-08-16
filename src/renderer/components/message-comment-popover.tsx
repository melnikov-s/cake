import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { observer } from "r-state-tree/react";
import { Markdown } from "@/components/ai-elements/markdown";
import { Button } from "@/components/ui/button";
import type { ReviewThreadModel } from "../models/review-thread";
import type { MessageCommentsStore, MessageSelectionAnchor } from "../stores/MessageCommentsStore";

export interface MessageCommentAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

function CloseIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18" /></svg>;
}

function anchorRect(anchor: HTMLElement | MessageCommentAnchorRect) {
  return anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
}

function useAnchoredPosition(anchor: HTMLElement | MessageCommentAnchorRect) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const update = useCallback(() => {
    const rect = anchorRect(anchor);
    const surface = surfaceRef.current?.getBoundingClientRect();
    const width = surface?.width || 380;
    const height = surface?.height || 360;
    const padding = 12;
    const gap = 10;
    const rightSide = rect.right + gap;
    const leftSide = rect.left - width - gap;
    const left = rightSide + width <= window.innerWidth - padding
      ? rightSide
      : leftSide >= padding
        ? leftSide
        : Math.min(Math.max(padding, rect.left), Math.max(padding, window.innerWidth - width - padding));
    const top = Math.min(
      Math.max(padding, rect.top - 14),
      Math.max(padding, window.innerHeight - height - padding)
    );
    setPosition({ left, top });
  }, [anchor]);

  useLayoutEffect(update, [update]);
  useEffect(() => {
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [update]);

  return { surfaceRef, position };
}

function useDismissablePopover(surfaceRef: RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !surfaceRef.current?.contains(event.target)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose, surfaceRef]);
}

function PopoverShell({ anchor, title, selectedText, onClose, children }: { anchor: HTMLElement | MessageCommentAnchorRect; title: string; selectedText: string; onClose(): void; children: ReactNode }) {
  const { surfaceRef, position } = useAnchoredPosition(anchor);
  useDismissablePopover(surfaceRef, onClose);
  return createPortal(
    <div ref={surfaceRef} className="message-comment-popover" style={position} role="dialog" aria-label={title}>
      <header><div><span>Selection</span><strong>{title}</strong></div><button type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}><CloseIcon /></button></header>
      <blockquote>{selectedText}</blockquote>
      {children}
    </div>,
    document.body
  );
}

export function MessageSelectionAction({ rect, onChat }: { rect: MessageCommentAnchorRect; onChat(anchor: MessageCommentAnchorRect): void }) {
  const style: CSSProperties = {
    left: Math.min(Math.max(12, (rect.left + rect.right) / 2), window.innerWidth - 12),
    top: Math.min(rect.bottom + 8, window.innerHeight - 44)
  };
  return createPortal(<button className="message-selection-action" type="button" style={style} onPointerDown={(event) => event.preventDefault()} onClick={(event) => onChat(event.currentTarget.getBoundingClientRect())}>Chat about this</button>, document.body);
}

export function MessageCommentDraftPopover({ anchor, selection, store, onCreated, onClose }: { anchor: MessageCommentAnchorRect; selection: MessageSelectionAnchor; store: MessageCommentsStore; onCreated(threadId: string): void; onClose(): void }) {
  const [question, setQuestion] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!question.trim() || submitting) return;
    setSubmitting(true);
    const threadId = await store.createThread(selection, question);
    setSubmitting(false);
    if (threadId) onCreated(threadId);
  };
  return <PopoverShell anchor={anchor} title="Chat about this" selectedText={selection.selectedText} onClose={onClose}>
    <form className="message-comment-draft" onSubmit={(event) => void submit(event)}>
      <textarea ref={inputRef} aria-label="Message about selected text" placeholder="Ask Cake about this passage…" value={question} disabled={submitting} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit();
      }} />
      <footer><span>⌘↵ to send</span><Button size="sm" type="submit" disabled={!question.trim() || submitting}>{submitting ? "Sending…" : "Send"}</Button></footer>
    </form>
  </PopoverShell>;
}

export const MessageCommentThreadPopover = observer(function MessageCommentThreadPopover({ anchor, thread, store, onClose }: { anchor: HTMLElement | MessageCommentAnchorRect; thread: ReviewThreadModel; store: MessageCommentsStore; onClose(): void }) {
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const streaming = store.threadStreaming(thread.id);
  useLayoutEffect(() => { messagesRef.current?.scrollTo?.({ top: messagesRef.current.scrollHeight }); }, [thread.messages.length, streaming]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!reply.trim() || replying) return;
    setReplying(true);
    if (await store.replyThread(thread.id, reply)) setReply("");
    setReplying(false);
  };
  return <PopoverShell anchor={anchor} title="Selection chat" selectedText={thread.anchor.selectedText} onClose={onClose}>
    <div ref={messagesRef} className="message-comment-messages">{thread.messages.map((message) => <div key={message.id} className={`message-comment-message ${message.role} ${message.status}`}><strong>{message.role === "user" ? "You" : "Cake"}</strong><Markdown>{message.body}</Markdown></div>)}</div>
    {streaming && <div className="message-comment-working"><span className="review-run-spinner" aria-hidden="true" />Cake is replying…</div>}
    {thread.status === "open" && !streaming && <form className="message-comment-reply" onSubmit={(event) => void submit(event)}><textarea aria-label="Reply to selection chat" placeholder="Ask a follow-up…" value={reply} disabled={replying} onChange={(event) => setReply(event.target.value)} onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.form?.requestSubmit();
    }} /><Button size="sm" type="submit" disabled={!reply.trim() || replying}>{replying ? "Sending…" : "Reply"}</Button></form>}
    <footer className="message-comment-thread-actions"><button type="button" onClick={() => void store.resolveThread(thread.id, thread.status !== "resolved")}>{thread.status === "resolved" ? "Reopen chat" : "Resolve chat"}</button></footer>
  </PopoverShell>;
});
