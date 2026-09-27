import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { observer } from "r-state-tree/react";
import type { DictationStore } from "../../stores/DictationStore";
import { LoadingSpinner } from "./loading-state";
import { CloseIcon, MicrophoneIcon } from "./icons";
import { IconButton } from "./icon-button";
import { cn } from "../../lib/utils";

/** Silent status and dismiss action anchored to the writing field that owns focus. */
export const DictationIndicator = observer(function DictationIndicator({
  store,
  targetId,
  anchor,
}: {
  store: DictationStore;
  targetId: string;
  anchor: RefObject<HTMLTextAreaElement | null>;
}) {
  const visible = store.enabled && store.activeTargetId === targetId;
  const phase = store.phase;
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  useLayoutEffect(() => {
    if (!visible || !anchor.current) return;
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 280)),
          top: Math.max(8, rect.top - 27),
        });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor.current);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [anchor, visible]);
  if (!visible) return null;
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-slot="dictation-indicator"
      style={position}
      className={cn(
        "fixed z-[100] flex max-w-80 items-center gap-1.5 rounded-md border border-border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow-sm",
        phase === "error" && "text-destructive",
      )}
    >
      {phase === "preparing" || phase === "finishing" ? (
        <LoadingSpinner label={store.label} />
      ) : (
        <MicrophoneIcon />
      )}
      {store.label}
      <IconButton
        className="ml-1 size-5"
        tooltip="Stop dictation"
        ariaLabel="Stop dictation"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          void store.setEnabled(false);
          anchor.current?.focus();
        }}
        onClick={() => void store.setEnabled(false)}
      >
        <CloseIcon size={12} />
      </IconButton>
    </div>,
    document.body,
  );
});
