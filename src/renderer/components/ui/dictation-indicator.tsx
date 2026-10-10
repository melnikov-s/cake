import type { RefObject } from "react";
import { observer } from "r-state-tree/react";
import type { DictationStore } from "../../stores/DictationStore";
import { LoadingSpinner } from "./loading-state";
import { AudioLinesOffIcon } from "./icons";
import { IconButton } from "./icon-button";
import { VoiceMeter } from "./voice-meter";
import { cn } from "../../lib/utils";

/** Circular dictation activity/mute control; pointer activation retains writing focus. */
export const DictationIndicator = observer(function DictationIndicator({
  store,
  targetId,
  anchor,
  inline = true,
}: {
  store: DictationStore;
  targetId: string;
  anchor: RefObject<HTMLTextAreaElement | null>;
  inline?: boolean;
}) {
  if (!store.enabled || store.activeTargetId !== targetId) return null;
  const failed = store.phase === "error" && !store.muted;
  const loading = !store.muted && (store.phase === "preparing" || store.phase === "finishing");
  const action = store.muted ? "Unmute dictation" : "Mute dictation";
  return (
    <div
      data-slot="dictation-indicator"
      data-dictation-target={targetId}
      className={cn("flex items-center", inline && "absolute top-2 left-2")}
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
        className={cn(
          "size-6 shrink-0 rounded-full border border-border text-primary aria-pressed:text-muted-foreground aria-pressed:hover:bg-muted aria-pressed:hover:text-foreground",
          failed && "border-destructive text-destructive",
        )}
        tooltip={failed ? `${store.label} — ${action}` : action}
        ariaLabel={action}
        aria-pressed={store.muted}
        aria-busy={loading}
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
        {store.muted || failed ? (
          <AudioLinesOffIcon />
        ) : loading ? (
          <span aria-hidden="true" className="grid">
            <LoadingSpinner />
          </span>
        ) : (
          <VoiceMeter level={store.audioLevel} size="sm" />
        )}
      </IconButton>
      <span role="status" aria-live="polite" className="sr-only">
        {store.label}
      </span>
    </div>
  );
});
