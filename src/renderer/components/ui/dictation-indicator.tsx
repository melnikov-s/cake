import type { RefObject } from "react";
import { observer } from "r-state-tree/react";
import type { DictationStore } from "../../stores/DictationStore";
import { LoadingSpinner } from "./loading-state";
import { AudioLinesOffIcon } from "./icons";
import { IconButton } from "./icon-button";
import { VoiceMeter } from "./voice-meter";
import { cn } from "../../lib/utils";

/** Leading circular voice activity/mute control; pointer activation retains writing focus. */
export const DictationIndicator = observer(function DictationIndicator({
  store,
  targetId,
  anchor,
}: {
  store: DictationStore;
  targetId: string;
  anchor: RefObject<HTMLTextAreaElement | null>;
}) {
  if (!store.enabled || store.activeTargetId !== targetId) return null;
  const compact = store.phase === "listening" || store.muted;
  const action = store.muted ? "Unmute dictation" : "Mute dictation";
  return (
    <div
      data-slot="dictation-indicator"
      className={cn(
        "absolute top-2 left-2 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground",
        !compact && "right-2",
        store.phase === "error" && "text-destructive",
      )}
      onBlur={(event) => {
        if (
          event.relatedTarget === anchor.current ||
          (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
        )
          return;
        store.blur(targetId);
      }}
    >
      <IconButton
        className="size-6 shrink-0 rounded-full border border-border text-primary aria-pressed:text-muted-foreground aria-pressed:hover:bg-muted aria-pressed:hover:text-foreground"
        tooltip={action}
        ariaLabel={action}
        aria-pressed={store.muted}
        pressedAppearance="subtle"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          store.setMuted(targetId, true);
          anchor.current?.focus();
        }}
        onClick={() => {
          store.setMuted(targetId, !store.muted);
          anchor.current?.focus();
        }}
      >
        {store.muted ? <AudioLinesOffIcon /> : <VoiceMeter level={store.audioLevel} size="sm" />}
      </IconButton>
      {!compact && (store.phase === "preparing" || store.phase === "finishing") && (
        <LoadingSpinner label={store.label} />
      )}
      <span
        role="status"
        aria-live="polite"
        className={cn(compact ? "sr-only" : "min-w-0 flex-1 truncate")}
        title={compact ? undefined : store.label}
      >
        {store.label}
      </span>
    </div>
  );
});
