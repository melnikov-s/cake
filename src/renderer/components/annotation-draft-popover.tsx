import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { IconButton } from "@/components/ui/icon-button";
import { SendIcon } from "@/components/ui/icons";
import { Textarea } from "@/components/ui/textarea";
import type { Annotation } from "../../ipc/session-contract";
import type { MessageSelectionAnchor } from "../stores/MessageCommentsStore";
import type { MessageCommentAnchorRect } from "./message-comment-popover";

function anchorRect(anchor: HTMLElement | MessageCommentAnchorRect) {
  return anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
}

export function AnnotationDraftPopover({
  anchor,
  selection,
  onAdd,
  onClose,
}: {
  anchor: HTMLElement | MessageCommentAnchorRect;
  selection: MessageSelectionAnchor;
  onAdd(annotation: Omit<Annotation, "id">): void;
  onClose(): void;
}) {
  const [comment, setComment] = useState("");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  const update = useCallback(() => {
    const rect = anchorRect(anchor);
    const surface = surfaceRef.current?.getBoundingClientRect();
    const width = surface?.width || 320;
    const height = surface?.height || 48;
    const padding = 12;
    const gap = 6;

    let top = rect.bottom + gap;
    if (top + height > window.innerHeight - padding) {
      top = Math.max(padding, rect.top - height - gap);
    }
    const left = Math.min(
      Math.max(padding, rect.left),
      Math.max(padding, window.innerWidth - width - padding),
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

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true });
    });
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !surfaceRef.current?.contains(event.target)) {
        onClose();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  const handleSubmit = useCallback(() => {
    onAdd({ ...selection, comment: comment.trim() || undefined });
    onClose();
  }, [comment, onAdd, onClose, selection]);

  return createPortal(
    <div
      ref={surfaceRef}
      className="fixed z-50 flex w-[min(22rem,calc(100vw-24px))] items-center gap-1.5 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-2xl"
      style={position}
      role="dialog"
      aria-label="Add annotation"
    >
      <form
        className="flex w-full items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          handleSubmit();
        }}
      >
        <Textarea
          ref={textareaRef}
          rows={1}
          aria-label="Annotation comment"
          className="max-h-40 min-h-8 resize-none border-none bg-transparent px-2.5 py-1.5 text-xs shadow-none focus-visible:border-none focus-visible:ring-0"
          placeholder="Add annotation..."
          value={comment}
          onChange={(event) => {
            setComment(event.currentTarget.value);
            const el = event.currentTarget;
            el.style.height = "auto";
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              handleSubmit();
            }
          }}
        />
        <IconButton
          type="submit"
          className="size-7 bg-primary text-primary-foreground hover:bg-primary/90"
          tooltip="Add annotation"
          ariaLabel="Add annotation"
        >
          <SendIcon />
        </IconButton>
      </form>
    </div>,
    document.body,
  );
}
