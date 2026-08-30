import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { observer } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CloseIcon } from "@/components/ui/icons";
import type { ReviewThread } from "../../models/ReviewThread";
import type { ChatStore } from "../stores/ChatStore";
import type { MessageCommentsStore } from "../stores/MessageCommentsStore";

export interface MessageCommentAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
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
      left: Math.min(
        Math.max(padding, left),
        Math.max(padding, window.innerWidth - (surface?.width ?? 380) - padding),
      ),
      top: Math.min(
        Math.max(padding, top),
        Math.max(padding, window.innerHeight - (surface?.height ?? 360) - padding),
      ),
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
    const left =
      rightSide + width <= window.innerWidth - padding
        ? rightSide
        : leftSide >= padding
          ? leftSide
          : Math.min(
              Math.max(padding, rect.left),
              Math.max(padding, window.innerWidth - width - padding),
            );
    const top = Math.min(
      Math.max(padding, rect.top - 14),
      Math.max(padding, window.innerHeight - height - padding),
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

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest("button")))
        return;
      const surface = surfaceRef.current;
      if (!surface) return;
      const rect = surface.getBoundingClientRect();
      const origin = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        left: rect.left,
        top: rect.top,
      };
      movedRef.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      const move = (moveEvent: PointerEvent) =>
        setPosition(
          clamp(
            origin.left + moveEvent.clientX - origin.pointerX,
            origin.top + moveEvent.clientY - origin.pointerY,
          ),
        );
      const stop = () => {
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", stop);
        document.removeEventListener("pointercancel", stop);
      };
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", stop);
      document.addEventListener("pointercancel", stop);
      event.preventDefault();
    },
    [clamp],
  );

  return { surfaceRef, position, startDrag };
}

function useDismissablePopover(surfaceRef: RefObject<HTMLDivElement | null>, onClose: () => void) {
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
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

export function ChatPopover({
  anchor,
  title,
  eyebrow = "Chat",
  onClose,
  children,
}: {
  anchor: HTMLElement | MessageCommentAnchorRect;
  title: string;
  eyebrow?: string;
  onClose(): void;
  children: ReactNode;
}) {
  const { surfaceRef, position, startDrag } = useAnchoredPosition(anchor);
  useDismissablePopover(surfaceRef, onClose);
  return createPortal(
    <div
      ref={surfaceRef}
      className="fixed z-50 flex max-h-[min(34rem,calc(100vh-24px))] w-[min(26rem,calc(100vw-24px))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-2xl"
      style={position}
      role="dialog"
      aria-label={title}
    >
      <header
        className="flex cursor-grab select-none items-center justify-between border-b border-border bg-muted/70 px-3 py-2 active:cursor-grabbing"
        onPointerDown={startDrag}
      >
        <div>
          <span className="block font-mono text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {eyebrow}
          </span>
          <strong className="block text-xs font-semibold text-foreground">{title}</strong>
        </div>
        <IconButton tooltip={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <CloseIcon size={16} strokeWidth={1.9} />
        </IconButton>
      </header>
      {children}
    </div>,
    document.body,
  );
}

export const MessageCommentDraftPopover = observer(function MessageCommentDraftPopover({
  anchor,
  chatStore,
  renderChat,
  onClose,
}: {
  anchor: MessageCommentAnchorRect;
  chatStore: ChatStore;
  renderChat(store: ChatStore): ReactNode;
  onClose(): void;
}) {
  return (
    <ChatPopover anchor={anchor} title="Chat about this" eyebrow="Selection" onClose={onClose}>
      {renderChat(chatStore)}
    </ChatPopover>
  );
});

export const MessageCommentThreadPopover = observer(function MessageCommentThreadPopover({
  anchor,
  thread,
  store,
  renderChat,
  onClose,
}: {
  anchor: HTMLElement | MessageCommentAnchorRect;
  thread: ReviewThread;
  store: MessageCommentsStore;
  renderChat(store: ChatStore): ReactNode;
  onClose(): void;
}) {
  const chat = store.chatStore(thread.id);
  return (
    <ChatPopover anchor={anchor} title="Selection chat" eyebrow="Selection" onClose={onClose}>
      {chat && renderChat(chat)}
    </ChatPopover>
  );
});
