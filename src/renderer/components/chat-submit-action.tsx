import { useEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { PauseIcon, PlayIcon, StopIcon } from "@/components/ui/icons";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { ComposerSubmitButton } from "@/components/ui/composer-submit-button";
import type { ChatStore } from "../stores/ChatStore";

/** Draft-bound send, activate, and stop control, isolated from the surrounding chat render. */
export const ChatSubmitAction = observer(function ChatSubmitAction({
  store,
}: {
  store: ChatStore;
}) {
  const activatingDraft = store.isDraftSession && !store.editingMessage;
  const hasInput =
    store.draft.trim().length > 0 || store.attachments.length > 0 || store.annotations.length > 0;

  return (
    <>
      {store.queuePaused && !activatingDraft && (
        <IconButton
          className="size-8 rounded-full"
          tooltip="Resume queue"
          onClick={() => void store.setQueuePaused(false)}
        >
          <PlayIcon />
        </IconButton>
      )}
      {(activatingDraft || !store.loading || hasInput) && (!store.queuePaused || hasInput) && (
        <ComposerSubmitButton
          data-cake-hint-key="u"
          tooltip={
            activatingDraft
              ? "Activate draft"
              : store.submitsAsDraft
                ? store.isDraftSession
                  ? "Save draft"
                  : "Create draft"
                : store.editingMessage && !store.isDraftSession
                  ? "Save and regenerate"
                  : store.isDraftSession
                    ? "Activate draft"
                    : "Send"
          }
          disabled={activatingDraft ? !store.canActivateDraft : !store.canSubmitDraft(store.draft)}
        />
      )}
      {store.canStop && (!hasInput || store.queuePaused) && !activatingDraft && (
        <StopAction key={store.id} store={store} />
      )}
    </>
  );
});

const STOP_HOLD_MS = 450;

const StopAction = observer(function StopAction({ store }: { store: ChatStore }) {
  const canPause = store.canPauseQueue && !store.queuePaused;
  const [open, setOpen] = useState(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const cancelHold = () => clearTimeout(timer.current);
  useEffect(() => cancelHold, []);
  useEffect(() => {
    if (!canPause) {
      cancelHold();
      setOpen(false);
    }
  }, [canPause]);

  return (
    <Popover open={open && canPause} onOpenChange={setOpen}>
      <IconButton
        ref={stopRef}
        className="size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
        tooltip={canPause ? "Stop (hold or ↑ for options)" : "Stop"}
        ariaLabel="Stop"
        aria-haspopup={canPause ? "dialog" : undefined}
        aria-expanded={canPause ? open : undefined}
        aria-keyshortcuts={canPause ? "ArrowUp Shift+F10" : undefined}
        onPointerDown={(event) => {
          held.current = false;
          if (!canPause || !event.isPrimary || event.button !== 0) return;
          timer.current = setTimeout(() => {
            held.current = true;
            setOpen(true);
          }, STOP_HOLD_MS);
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onContextMenu={(event) => {
          if (!canPause) return;
          event.preventDefault();
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (!canPause || (event.key !== "ArrowUp" && !(event.shiftKey && event.key === "F10")))
            return;
          event.preventDefault();
          setOpen(true);
        }}
        onClick={(event) => {
          if (held.current && event.detail !== 0) {
            held.current = false;
            return;
          }
          void store.abort();
        }}
      >
        <StopIcon />
      </IconButton>
      <PopoverContent
        anchorRef={stopRef}
        aria-label="Queue options"
        side="top"
        align="end"
        className="p-1"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            stopRef.current?.focus();
            void store.setQueuePaused(true);
          }}
        >
          <PauseIcon /> Pause queue
        </Button>
      </PopoverContent>
    </Popover>
  );
});
