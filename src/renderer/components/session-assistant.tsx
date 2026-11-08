import { useEffect, type MouseEvent } from "react";
import { observer } from "r-state-tree/react";
import { cn } from "@/lib/utils";
import type { SessionLabel } from "../../contracts/application/application-data";
import { Chat } from "./chat";
import { Callout } from "./ui/callout";
import { Avatar } from "./ui/avatar";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import { ThinkingBubble } from "./ui/thinking-bubble";
import { IconButton } from "./ui/icon-button";
import { CloseIcon } from "./ui/icons";
import type { SessionAssistantStore } from "../stores/SessionAssistantStore";

function composerSelection(trigger: HTMLElement) {
  const input = trigger
    .closest<HTMLElement>('[data-slot="composer-dock"]')
    ?.querySelector<HTMLTextAreaElement>(".workbench-composer textarea");
  if (!input || input.selectionStart === input.selectionEnd) return undefined;
  return input.value.slice(input.selectionStart, input.selectionEnd).slice(0, 32_000);
}

/** Composer avatar trigger for quick and full views of its durable assistant side chat. */
export const SessionAssistant = observer(function SessionAssistant({
  store,
  seed,
  labels,
  value,
  animated = false,
}: {
  store: SessionAssistantStore;
  seed: string;
  labels: readonly SessionLabel[];
  value: readonly string[];
  animated?: boolean;
}) {
  const open = store.open && store.contextSessionId === seed;
  const surface = store.surface;
  const setOpen = (value: boolean) => store.setOpen(value);
  const labelColors = value.flatMap((labelId) => {
    const label = labels.find((candidate) => candidate.id === labelId);
    return label ? [label.color] : [];
  });
  const processing = store.processing;
  const quickResponse = store.quickParts.length > 0;

  useEffect(() => {
    if (open) store.requestFocus();
  }, [open, store, surface]);

  const openFullChat = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setOpen(true);
    store.beginChat(composerSelection(event.currentTarget));
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverIconTrigger
        ariaLabel="Ask session assistant"
        hotkey="open-companion"
        onMouseDown={(event) => {
          // Keep the parent composer selection intact until the assistant snapshots it.
          if (event.button === 0) event.preventDefault();
        }}
        onClick={(event) => {
          event.preventDefault();
          if (open) setOpen(false);
          else store.openQuickPrompt(composerSelection(event.currentTarget));
        }}
        onContextMenu={openFullChat}
        className="size-8 rounded-full p-0 hover:bg-muted [&_[data-slot=avatar]]:size-7"
      >
        <Avatar
          kind="session"
          seed={seed}
          labelColors={labelColors}
          animated={animated}
          className="size-7"
        />
      </PopoverIconTrigger>
      {surface === "quick" ? (
        <PopoverContent
          side={quickResponse ? "left" : "top"}
          align="center"
          boundary="nearest-ancestor"
          offset={quickResponse ? 12 : 8}
          aria-label="Quick session assistant"
          dismissOnEscapeCapture
          initialFocusSelector="textarea:not([disabled])"
          // Portals still bubble React events through the parent composer form.
          onSubmit={(event) => event.stopPropagation()}
          className={cn(
            "overflow-hidden rounded-xl p-0",
            processing || quickResponse
              ? "w-fit overflow-visible border-0 bg-transparent shadow-none"
              : "w-[min(22rem,calc(100vw-24px))]",
            quickResponse &&
              // The message owns the bubble shell; transcript row/footer spacing is for full chats.
              "w-[min(19rem,calc(100vw-24px))] max-w-[min(22rem,calc(100vw-24px))] rounded-2xl ring-0 backdrop-blur-none [&_[aria-label=Conversation]]:p-0 [&_[data-slot=transcript-item]]:pb-0 [&_[data-slot=transcript-footer]]:pb-0",
          )}
        >
          {processing ? (
            <ThinkingBubble />
          ) : (
            <>
              {store.error && (
                <Callout variant="error" className="m-2">
                  {store.error}
                </Callout>
              )}
              <Chat
                store={store.quickChatStore}
                compact
                embedded
                composerFocusEnabled
                parkComposerFocusWhileDictating={false}
                inlineComposer
                className={cn(
                  "h-auto max-h-[min(18rem,60vh)] [&_.transcript]:max-h-[min(18rem,60vh)] [&_[data-slot=message]]:w-fit [&_[data-slot=message-content]]:max-w-[min(22rem,calc(100vw-24px))] [&_[data-slot=message-content]]:px-3 [&_[data-slot=message-content]]:py-2.5 [&_[data-slot=message-content]]:text-xs [&_[data-slot=message-content]]:leading-5 [&_[data-slot=message-content]]:shadow-none [&_[data-slot=message-actions]]:hidden [&_[data-slot=message-action-clearance]]:hidden",
                  !quickResponse && "[&_.transcript]:hidden",
                  quickResponse &&
                    "[&_[data-slot=message-content]]:rounded-2xl [&_[data-slot=message-content]]:rounded-br-md [&_[data-slot=message-content]]:border-border/70 [&_[data-slot=message-content]]:bg-card/95 [&_[data-slot=message-content]]:shadow-lg",
                )}
                transcriptBehavior={{ showAssistantFullscreen: false }}
              />
            </>
          )}
        </PopoverContent>
      ) : (
        <PopoverContent
          side="left"
          align="end"
          boundary="nearest-ancestor"
          offset={12}
          aria-label="Session assistant chat"
          dismissOnEscapeCapture
          initialFocusSelector="textarea:not([disabled])"
          onSubmit={(event) => event.stopPropagation()}
          className="h-[min(26rem,72vh)] w-[min(22rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl p-0"
        >
          <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
            <div className="flex h-9 items-center justify-between border-b border-border/65 bg-sidebar/30 pl-3.5 pr-1">
              <p className="text-xs font-semibold text-foreground">Companion</p>
              <IconButton ariaLabel="Close companion" onClick={() => setOpen(false)}>
                <CloseIcon size={14} />
              </IconButton>
            </div>
            <Chat
              store={store.chatStore}
              parkComposerFocusWhileDictating={false}
              compact
              embedded
              inlineComposer
              className="[&_[data-slot=message]]:gap-1.5 [&_[data-slot=message-content]]:rounded-lg [&_[data-slot=message-content]]:px-3 [&_[data-slot=message-content]]:py-2 [&_[data-slot=message-content]]:text-xs [&_[data-slot=message-content]]:leading-5 [&_[data-slot=message-content]]:shadow-none [&_[data-slot=message-label]]:text-xs [&_form]:rounded-lg [&_form]:border [&_form]:bg-composer [&_form]:p-2 [&_textarea]:min-h-9 [&_textarea]:px-2 [&_textarea]:py-1.5 [&_textarea]:text-sm"
              error={store.error ? { message: store.error, title: "Assistant failed" } : undefined}
              empty={
                <div className="grid h-full place-items-center p-5 text-center text-xs leading-relaxed text-muted-foreground">
                  Ask for a quick answer or an action in Cake.
                </div>
              }
            />
          </div>
        </PopoverContent>
      )}
    </Popover>
  );
});
