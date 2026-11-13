import { useEffect, useState } from "react";
import { observer } from "r-state-tree/react";
import type { WidgetAttachment as Attachment } from "../../contracts/widgets/widget-attachment";
import type { ArtifactNavigationContext } from "../../contracts/artifacts/artifact-navigation-context";
import type { WidgetAttachmentStore } from "../stores/WidgetAttachmentStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { WidgetArtifact } from "./widget-artifact";
import { Button } from "./ui/button";
import { useWidgetPlacement } from "./widget-placement";
import { Callout } from "./ui/callout";
import { LoadingState } from "./ui/loading-state";
import { Popover, PopoverContent, PopoverIconTrigger } from "./ui/popover";
import { SettingsIcon } from "./ui/icons";

export const WidgetAttachment = observer(function WidgetAttachment({
  attachment,
  store,
  widgets,
  session,
}: {
  attachment: Attachment;
  store: WidgetAttachmentStore;
  widgets: InlineWidgetStore;
  session: ArtifactNavigationContext["session"];
}) {
  const placement = useWidgetPlacement();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const artifact = store.artifacts.get(attachment.lineageId);
  const loadError = store.errors.get(attachment.lineageId);
  useEffect(() => {
    if (!attachment.hidden) void store.load(attachment.lineageId);
  }, [store, attachment.lineageId, attachment.hidden]);
  const perform = (action: () => Promise<void>) => {
    setPending(true);
    setError(undefined);
    void action()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setPending(false));
  };
  const title = artifact?.title ?? attachment.id;
  return (
    <section
      className={
        attachment.slot === "tab"
          ? "flex h-full min-h-0 min-w-0 flex-col"
          : "flex min-h-0 min-w-0 flex-col border-b border-border/65"
      }
      aria-label={title}
      data-widget-attachment={attachment.id}
    >
      <div
        className="flex cursor-grab touch-none items-center gap-1 px-2 py-1 [app-region:no-drag]"
        onPointerDown={(event) => {
          const target = event.target;
          if (
            target instanceof HTMLElement &&
            !pending &&
            event.currentTarget.contains(target) &&
            !target.closest("[data-widget-options]")
          )
            placement?.pointer(event, attachment);
        }}
        style={
          attachment.slot === "top" || attachment.slot === "left"
            ? { paddingLeft: "var(--session-home-control-inset, 0.5rem)" }
            : undefined
        }
      >
        <button
          type="button"
          className="min-w-0 flex-1 cursor-grab touch-none truncate text-left text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring [app-region:no-drag]"
          title={`${title} — drag to move, or press Enter for keyboard placement`}
          aria-label={`Move ${title}`}
          aria-description="Drag to a chat edge or Workspace. Press Enter for keyboard placement."
          disabled={pending}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            placement?.keyboard(attachment);
          }}
        >
          <span>{title}</span>
        </button>
        <div data-widget-options className="flex shrink-0 cursor-default">
          <Popover>
            <PopoverIconTrigger tooltip={`Widget options for ${title}`} disabled={pending}>
              <SettingsIcon size={14} />
            </PopoverIconTrigger>
            <PopoverContent
              align="end"
              className="w-52 space-y-2 p-2"
              aria-label={`Options for ${title}`}
            >
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start"
                aria-expanded={!attachment.hidden}
                disabled={pending}
                onClick={() => perform(() => store.hide(attachment.id, !attachment.hidden))}
              >
                {attachment.hidden ? "Show" : "Hide"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="w-full justify-start text-destructive hover:bg-destructive/10 hover:text-destructive"
                aria-label={`Close ${title}`}
                disabled={pending}
                onClick={() => perform(() => store.detach(attachment.id))}
              >
                Close
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      {error && <Callout variant="error">{error}</Callout>}
      {!attachment.hidden &&
        (loadError ? (
          <Callout variant="error">
            {loadError}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void store.load(attachment.lineageId)}
            >
              Retry
            </Button>
          </Callout>
        ) : artifact ? (
          <WidgetArtifact
            artifact={artifact}
            fill={attachment.slot === "tab"}
            inlineWidgets={widgets}
            attachmentId={attachment.id}
            stateSessionId={
              attachment.target.kind === "session" ? attachment.target.sessionId : undefined
            }
            viewSession={session}
          />
        ) : (
          <LoadingState label={`Loading ${title}`} />
        ))}
    </section>
  );
});
