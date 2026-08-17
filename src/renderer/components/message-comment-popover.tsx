import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { observer } from "r-state-tree/react";
import { Message, MessageContent, MessageLabel } from "@/components/ai-elements/message";
import type { ReviewThreadModel } from "../models/review-thread";
import type { ChatStore } from "../stores/ChatStore";
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
  const movedRef = useRef(false);
  const clamp = useCallback((left: number, top: number) => {
    const surface = surfaceRef.current?.getBoundingClientRect();
    const padding = 12;
    return {
      left: Math.min(Math.max(padding, left), Math.max(padding, window.innerWidth - (surface?.width ?? 380) - padding)),
      top: Math.min(Math.max(padding, top), Math.max(padding, window.innerHeight - (surface?.height ?? 360) - padding))
    };
  }, []);
  const update = useCallback(() => {
    if (movedRef.current) {
      const surface = surfaceRef.current?.getBoundingClientRect();
      if (surface) setPosition(clamp(surface.left, surface.top));
      return;
    }
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
  }, [anchor, clamp]);

  useLayoutEffect(update, [update]);
  useEffect(() => {
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [update]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !("ResizeObserver" in globalThis)) return;
    const observer = new globalThis.ResizeObserver(() => {
      const rect = surface.getBoundingClientRect();
      movedRef.current = true;
      setPosition(clamp(rect.left, rect.top));
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, [clamp]);

  const startDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button"))) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const origin = { pointerX: event.clientX, pointerY: event.clientY, left: rect.left, top: rect.top };
    movedRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => setPosition(clamp(origin.left + moveEvent.clientX - origin.pointerX, origin.top + moveEvent.clientY - origin.pointerY));
    const stop = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", stop);
      document.removeEventListener("pointercancel", stop);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", stop);
    document.addEventListener("pointercancel", stop);
    event.preventDefault();
  }, [clamp]);

  return { surfaceRef, position, startDrag };
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

function PopoverShell({ anchor, title, selectedText, className, onClose, children }: { anchor: HTMLElement | MessageCommentAnchorRect; title: string; selectedText: string; className?: string; onClose(): void; children: ReactNode }) {
  const { surfaceRef, position, startDrag } = useAnchoredPosition(anchor);
  useDismissablePopover(surfaceRef, onClose);
  return createPortal(
    <div ref={surfaceRef} className={`message-comment-popover${className ? ` ${className}` : ""}`} style={position} role="dialog" aria-label={title}>
      <header className="message-comment-titlebar" onPointerDown={startDrag}><div><span>Selection</span><strong>{title}</strong></div><button type="button" aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}><CloseIcon /></button></header>
      <Message className="message-comment-selection ml-auto w-[min(88%,42rem)]">
        <MessageLabel>You · selected</MessageLabel>
        <MessageContent className="user-message whitespace-pre-wrap">{selectedText}</MessageContent>
      </Message>
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

export const MessageCommentDraftPopover = observer(function MessageCommentDraftPopover({ anchor, selection, store, chatStore, renderChat, onCreated, onClose }: { anchor: MessageCommentAnchorRect; selection: MessageSelectionAnchor; store: MessageCommentsStore; chatStore: ChatStore; renderChat(store: ChatStore, onSubmitted?: () => void, options?: { composerOnly?: boolean; draftValue?: string; onDraftValueChange?(value: string): void }): ReactNode; onCreated(threadId: string): void; onClose(): void }) {
  const [draftValue, setDraftValue] = useState(chatStore.draft);
  return <PopoverShell anchor={anchor} title="Chat about this" selectedText={selection.selectedText} className="message-comment-draft-popover" onClose={onClose}>
    {renderChat(chatStore, () => { if (store.createdThreadId) onCreated(store.createdThreadId); }, { composerOnly: true, draftValue, onDraftValueChange: setDraftValue })}
  </PopoverShell>;
});

export const MessageCommentThreadPopover = observer(function MessageCommentThreadPopover({ anchor, thread, store, renderChat, onClose }: { anchor: HTMLElement | MessageCommentAnchorRect; thread: ReviewThreadModel; store: MessageCommentsStore; renderChat(store: ChatStore): ReactNode; onClose(): void }) {
  const chat = store.chatStore(thread.id);
  return <PopoverShell anchor={anchor} title="Selection chat" selectedText={thread.anchor.selectedText} className="message-comment-thread-popover" onClose={onClose}>
    {chat && renderChat(chat)}
  </PopoverShell>;
});
