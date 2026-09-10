import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { observer } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { CheckIcon, CloseIcon, EditIcon, TrashIcon } from "@/components/ui/icons";
import { Textarea } from "@/components/ui/textarea";
import type { Annotation } from "../../ipc/session-contract";
import type { MessageCommentAnchorRect } from "./message-comment-anchor";

function anchorRect(anchor: HTMLElement | MessageCommentAnchorRect) {
  return anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : anchor;
}

export const AnnotationItemPopover = observer(function AnnotationItemPopover({
  anchor,
  annotation,
  onUpdate,
  onRemove,
  onClose,
}: {
  anchor: HTMLElement | MessageCommentAnchorRect;
  annotation: Annotation;
  onUpdate(id: string, update: Partial<Omit<Annotation, "id">>): void;
  onRemove(id: string): void;
  onClose(): void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftComment, setDraftComment] = useState(annotation.comment ?? "");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    if (!isEditing) {
      setDraftComment(annotation.comment ?? "");
    }
  }, [annotation.comment, isEditing]);

  const update = useCallback(() => {
    const rect = anchorRect(anchor);
    const surface = surfaceRef.current?.getBoundingClientRect();
    const width = surface?.width || 280;
    const height = surface?.height || 80;
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

  useLayoutEffect(update, [update, isEditing]);

  useEffect(() => {
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [update]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !surfaceRef.current?.contains(event.target)) {
        onClose();
      }
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (isEditing) {
          setIsEditing(false);
          setDraftComment(annotation.comment ?? "");
        } else {
          onClose();
        }
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [isEditing, onClose, annotation.comment]);

  const handleSave = useCallback(() => {
    onUpdate(annotation.id, { comment: draftComment.trim() || undefined });
    setIsEditing(false);
  }, [annotation.id, draftComment, onUpdate]);

  return createPortal(
    <div
      ref={surfaceRef}
      className="fixed z-50 flex max-h-72 w-[min(22rem,calc(100vw-24px))] flex-col gap-2 rounded-xl border border-border bg-popover p-2.5 text-popover-foreground shadow-2xl"
      style={position}
      role="dialog"
      aria-label="Annotation details"
    >
      {isEditing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            handleSave();
          }}
        >
          <Textarea
            ref={textareaRef}
            rows={2}
            aria-label="Edit annotation comment"
            className="max-h-40 min-h-12 resize-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/30"
            placeholder="Add annotation..."
            value={draftComment}
            onChange={(event) => {
              setDraftComment(event.currentTarget.value);
              const el = event.currentTarget;
              el.style.height = "auto";
              el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                handleSave();
              }
            }}
          />
          <div className="flex items-center justify-end gap-1">
            <IconButton
              type="button"
              className="size-7"
              tooltip="Cancel"
              ariaLabel="Cancel editing"
              onClick={() => {
                setDraftComment(annotation.comment ?? "");
                setIsEditing(false);
              }}
            >
              <CloseIcon size={14} />
            </IconButton>
            <IconButton
              type="submit"
              className="size-7 bg-primary text-primary-foreground hover:bg-primary/90"
              tooltip="Save annotation"
              ariaLabel="Save annotation"
            >
              <CheckIcon />
            </IconButton>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="max-h-48 overflow-y-auto px-1 py-0.5 text-xs leading-relaxed text-foreground whitespace-pre-wrap">
            {annotation.comment || (
              <span className="italic text-muted-foreground">{annotation.selectedText}</span>
            )}
          </div>
          <div className="flex items-center justify-end gap-1 border-t border-border/60 pt-1.5">
            <IconButton
              className="size-7"
              tooltip="Edit annotation"
              ariaLabel="Edit annotation"
              onClick={() => setIsEditing(true)}
            >
              <EditIcon />
            </IconButton>
            <IconButton
              className="size-7"
              tooltip="Delete annotation"
              ariaLabel="Delete annotation"
              onClick={() => {
                onRemove(annotation.id);
                onClose();
              }}
            >
              <TrashIcon size={14} />
            </IconButton>
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
});
