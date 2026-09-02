import { useLayoutEffect, useRef, useState } from "react";
import { observer } from "r-state-tree/react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { SendIcon, StopIcon } from "@/components/ui/icons";
import { Popover, PopoverContent } from "@/components/ui/popover";
import type { ChatStore } from "../stores/ChatStore";

/** Draft-bound send/stop control, isolated from the surrounding chat render. */
export const ChatSubmitAction = observer(function ChatSubmitAction({
  store,
}: {
  store: ChatStore;
}) {
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const suppressSendClickRef = useRef(false);
  const [draftMenuOpen, setDraftMenuOpen] = useState(false);

  useLayoutEffect(
    () => () => {
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    },
    [],
  );

  const hasInput =
    store.draft.trim().length > 0 || store.attachments.length > 0 || store.annotations.length > 0;

  return (
    <>
      {(!store.loading || hasInput) && (
        <Popover open={draftMenuOpen} onOpenChange={setDraftMenuOpen}>
          <IconButton
            ref={sendButtonRef}
            className="size-8 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-45"
            tooltip={
              store.editingMessage
                ? store.isDraftSession
                  ? "Save draft"
                  : "Save and regenerate"
                : store.canCreateDraft
                  ? "Send · hold to save as draft"
                  : "Send"
            }
            type="submit"
            disabled={!store.canSubmitDraft(store.draft)}
            onClick={(event) => {
              if (!suppressSendClickRef.current) return;
              event.preventDefault();
              suppressSendClickRef.current = false;
            }}
            onContextMenu={(event) => {
              if (!store.canCreateDraft) return;
              event.preventDefault();
              setDraftMenuOpen(true);
            }}
            onPointerDown={() => {
              if (!store.canCreateDraft) return;
              suppressSendClickRef.current = false;
              holdTimerRef.current = setTimeout(() => {
                suppressSendClickRef.current = true;
                setDraftMenuOpen(true);
              }, 600);
            }}
            onPointerUp={() => {
              if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
              holdTimerRef.current = undefined;
            }}
            onPointerCancel={() => {
              if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
              holdTimerRef.current = undefined;
            }}
            onPointerLeave={() => {
              if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
              holdTimerRef.current = undefined;
            }}
          >
            <SendIcon />
          </IconButton>
          <PopoverContent
            anchorRef={sendButtonRef}
            align="end"
            className="w-44 p-1"
            role="menu"
            side="top"
          >
            <Button
              className="w-full justify-start"
              role="menuitem"
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraftMenuOpen(false);
                void store.createDraft();
              }}
            >
              Create draft
            </Button>
          </PopoverContent>
        </Popover>
      )}
      {store.canStop && !hasInput && (
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
