import type { RefObject } from "react";
import { observer } from "r-state-tree/react";
import type { DictationStore } from "../../stores/DictationStore";
import { LoadingSpinner } from "./loading-state";
import { CloseIcon, MicrophoneIcon } from "./icons";
import { IconButton } from "./icon-button";
import { VoiceMeter } from "./voice-meter";
import { cn } from "../../lib/utils";

/** In-field voice activity, status and dismiss action; never steals writing focus. */
export const DictationIndicator = observer(function DictationIndicator({
  store,
  targetId,
  anchor,
}: {
  store: DictationStore;
  targetId: string;
  anchor: RefObject<HTMLTextAreaElement | null>;
}) {
  if (!store.enabled || store.activeTargetId !== targetId || store.isDismissed(targetId))
    return null;
  const listening = store.phase === "listening";
  return (
    <div
      data-slot="dictation-indicator"
      className={cn(
        "absolute top-2 right-2 flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground",
        !listening && "left-2",
        store.phase === "error" && "text-destructive",
      )}
    >
      {listening ? (
        <VoiceMeter level={store.audioLevel} />
      ) : store.phase === "preparing" || store.phase === "finishing" ? (
        <LoadingSpinner label={store.label} />
      ) : (
        <MicrophoneIcon aria-hidden="true" />
      )}
      <span
        role="status"
        aria-live="polite"
        className={cn(listening ? "sr-only" : "min-w-0 flex-1 truncate")}
        title={listening ? undefined : store.label}
      >
        {store.label}
      </span>
      <IconButton
        className="size-5 shrink-0"
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
          store.dismiss(targetId);
          anchor.current?.focus();
        }}
        onClick={() => store.dismiss(targetId)}
      >
        <CloseIcon size={12} />
      </IconButton>
    </div>
  );
});
