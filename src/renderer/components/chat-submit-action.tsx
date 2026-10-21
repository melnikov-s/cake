import { observer } from "r-state-tree/react";
import { IconButton } from "@/components/ui/icon-button";
import { ClockIcon, SendIcon, StopIcon } from "@/components/ui/icons";
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
      {store.streaming && hasInput && !activatingDraft && !store.editingMessage && (
        <IconButton
          tooltip="Queue for later (ordered work)"
          aria-label="Queue for later"
          type="button"
          disabled={!store.canSubmitDraft(store.draft)}
          onClick={() => void store.submit(undefined, { delivery: "prompt" })}
        >
          <ClockIcon />
        </IconButton>
      )}
      {(activatingDraft || !store.loading || hasInput) && (
        <IconButton
          data-cake-hint-key="u"
          {...(store.streaming && !activatingDraft && !store.editingMessage
            ? { "aria-label": "Send" }
            : {})}
          className="size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-45"
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
                    : store.streaming
                      ? "Steer active work"
                      : "Send"
          }
          type="submit"
          disabled={activatingDraft ? !store.canActivateDraft : !store.canSubmitDraft(store.draft)}
        >
          <SendIcon />
        </IconButton>
      )}
      {store.canStop && !hasInput && !activatingDraft && (
        <IconButton
          className="size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
          tooltip="Stop"
          onClick={() => void store.abort()}
        >
          <StopIcon />
        </IconButton>
      )}
    </>
  );
});
