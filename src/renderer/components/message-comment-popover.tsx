import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { observer } from "r-state-tree/react";
import type { FloatingWindowGeometry } from "@/components/ui/floating-window";
import {
  clampFloatingWindowGeometry,
  FloatingWindow,
  FLOATING_WINDOW_MARGIN,
  maximizedFloatingWindowGeometry,
} from "@/components/ui/floating-window";
import type { ReviewThread } from "../models/ReviewThread";
import type { ChatStore } from "../stores/ChatStore";
import type { MessageCommentsStore } from "../stores/MessageCommentsStore";

export interface MessageCommentAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Gap between the anchor and the popup surface. */
const ANCHOR_GAP = 10;
/** Default popup width (26rem), clamped to the viewport. */
const PANEL_DEFAULT_WIDTH = 416;
/** Content-sized popups never grow past 34rem (or the viewport). */
const PANEL_AUTO_HEIGHT_CLASS = "max-h-[min(34rem,calc(100vh-24px))]";

function anchorRect(anchor: HTMLElement | MessageCommentAnchorRect) {
  return anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
}

/** Initial placement beside the anchor, preferring the right side. */
function initialPanelGeometry(
  anchor: HTMLElement | MessageCommentAnchorRect,
): FloatingWindowGeometry {
  const rect = anchorRect(anchor);
  const width = Math.min(PANEL_DEFAULT_WIDTH, window.innerWidth - FLOATING_WINDOW_MARGIN * 2);
  const rightSide = rect.right + ANCHOR_GAP;
  const leftSide = rect.left - width - ANCHOR_GAP;
  const left =
    rightSide + width <= window.innerWidth - FLOATING_WINDOW_MARGIN
      ? rightSide
      : leftSide >= FLOATING_WINDOW_MARGIN
        ? leftSide
        : Math.min(
            Math.max(FLOATING_WINDOW_MARGIN, rect.left),
            Math.max(FLOATING_WINDOW_MARGIN, window.innerWidth - width - FLOATING_WINDOW_MARGIN),
          );
  const top = Math.min(
    Math.max(FLOATING_WINDOW_MARGIN, rect.top - 14),
    Math.max(FLOATING_WINDOW_MARGIN, window.innerHeight - FLOATING_WINDOW_MARGIN),
  );
  return { left, top, width, height: "auto" };
}

interface PanelState {
  geometry: FloatingWindowGeometry;
  maximized: boolean;
  restore: FloatingWindowGeometry | null;
}

/**
 * Anchored popup placement with free resizing and a maximized mode. Once the
 * user moves or resizes the panel it stops following the anchor; window
 * resizes only clamp it back into view.
 */
function useAnchoredPanel(anchor: HTMLElement | MessageCommentAnchorRect) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const movedRef = useRef(false);
  const [panel, setPanel] = useState<PanelState>(() => ({
    geometry: initialPanelGeometry(anchor),
    maximized: false,
    restore: null,
  }));

  const update = useCallback(() => {
    setPanel((current) => {
      if (current.maximized) return { ...current, geometry: maximizedFloatingWindowGeometry() };
      if (movedRef.current) {
        const measuredAutoHeight = surfaceRef.current?.getBoundingClientRect().height;
        return {
          ...current,
          geometry: clampFloatingWindowGeometry(current.geometry, measuredAutoHeight),
        };
      }
      const rect = anchorRect(anchor);
      const surface = surfaceRef.current?.getBoundingClientRect();
      const { width } = current.geometry;
      const height =
        current.geometry.height === "auto" ? (surface?.height ?? 360) : current.geometry.height;
      const left =
        rect.right + ANCHOR_GAP + width <= window.innerWidth - FLOATING_WINDOW_MARGIN
          ? rect.right + ANCHOR_GAP
          : rect.left - width - ANCHOR_GAP >= FLOATING_WINDOW_MARGIN
            ? rect.left - width - ANCHOR_GAP
            : Math.min(
                Math.max(FLOATING_WINDOW_MARGIN, rect.left),
                Math.max(
                  FLOATING_WINDOW_MARGIN,
                  window.innerWidth - width - FLOATING_WINDOW_MARGIN,
                ),
              );
      const top = Math.min(
        Math.max(FLOATING_WINDOW_MARGIN, rect.top - 14),
        Math.max(FLOATING_WINDOW_MARGIN, window.innerHeight - height - FLOATING_WINDOW_MARGIN),
      );
      return { ...current, geometry: { ...current.geometry, left, top } };
    });
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

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || !("ResizeObserver" in globalThis)) return;
    const resizeObserver = new globalThis.ResizeObserver(() => {
      movedRef.current = true;
      update();
    });
    resizeObserver.observe(surface);
    return () => resizeObserver.disconnect();
  }, [update]);

  const handleGeometryChange = useCallback((geometry: FloatingWindowGeometry) => {
    movedRef.current = true;
    setPanel((current) => ({ ...current, geometry }));
  }, []);

  const toggleMaximize = useCallback(() => {
    setPanel((current) => {
      if (current.maximized) {
        return {
          ...current,
          maximized: false,
          geometry: current.restore
            ? clampFloatingWindowGeometry(current.restore)
            : current.geometry,
        };
      }
      return {
        geometry: maximizedFloatingWindowGeometry(),
        maximized: true,
        restore: current.geometry,
      };
    });
  }, []);

  return { surfaceRef, panel, handleGeometryChange, toggleMaximize };
}

function useDismissablePanel(
  surfaceRef: RefObject<HTMLDivElement | null>,
  onClose: () => void,
  onEscape: () => void,
) {
  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !surfaceRef.current?.contains(event.target)) onClose();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose, onEscape, surfaceRef]);
}

/**
 * The authoritative popup chat window: anchored to a message or control,
 * freely resizable via its edges and corners, maximizable to fill the window
 * by double-clicking the header or using the green traffic light, and closed
 * via the red traffic light, Escape, or clicking outside.
 */
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
  const { surfaceRef, panel, handleGeometryChange, toggleMaximize } = useAnchoredPanel(anchor);
  useDismissablePanel(surfaceRef, onClose, panel.maximized ? toggleMaximize : onClose);
  return createPortal(
    <FloatingWindow
      surfaceRef={surfaceRef}
      geometry={panel.geometry}
      maximized={panel.maximized}
      title={title}
      eyebrow={eyebrow}
      autoHeightClassName={PANEL_AUTO_HEIGHT_CLASS}
      onClose={onClose}
      onToggleMaximize={toggleMaximize}
      onGeometryChange={handleGeometryChange}
    >
      {children}
    </FloatingWindow>,
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
