import { useEffect, useState } from "react";
import { observer } from "r-state-tree/react";
import type { WidgetAttachment as Attachment } from "../../contracts/widgets/widget-attachment";
import type { ArtifactNavigationContext } from "../../contracts/artifacts/artifact-navigation-context";
import type { WidgetAttachmentStore } from "../stores/WidgetAttachmentStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { WidgetArtifact } from "./widget-artifact";
import { Button } from "./ui/button";
import { Select } from "./ui/select";
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
        className="flex items-center gap-1 px-2 py-1"
        style={
          attachment.slot === "top"
            ? { paddingLeft: "var(--session-home-control-inset, 0.5rem)" }
            : undefined
        }
      >
        <span
          className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground"
          title={title}
        >
          {title}
        </span>
        {attachment.slot !== "tab" && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={!attachment.hidden}
            disabled={pending}
            onClick={() => perform(() => store.hide(attachment.id, !attachment.hidden))}
          >
            {attachment.hidden ? "Show" : "Hide"}
          </Button>
        )}
        <Popover>
          <PopoverIconTrigger tooltip={`Widget options for ${title}`} disabled={pending}>
            <SettingsIcon size={14} />
          </PopoverIconTrigger>
          <PopoverContent
            align="end"
            className="w-52 space-y-2 p-2"
            aria-label={`Options for ${title}`}
          >
            <span className="text-xs text-muted-foreground">Position</span>
            <Select
              size="sm"
              aria-label={`Move ${title}`}
              value={attachment.slot}
              disabled={pending}
              onChange={(event) => {
                const slot = event.target.value;
                if (
                  slot === "top" ||
                  slot === "bottom" ||
                  slot === "left" ||
                  slot === "right" ||
                  (slot === "tab" && attachment.target.kind === "global")
                )
                  perform(() => store.move(attachment, slot));
              }}
            >
              <option value="top">Top</option>
              <option value="bottom">Bottom</option>
              <option value="left">Left</option>
              <option value="right">Right</option>
              {attachment.target.kind === "global" && <option value="tab">Tab</option>}
            </Select>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="ghost"
                className="flex-1"
                aria-label={`Move ${title} earlier`}
                disabled={pending || attachment.order === 0}
                onClick={() =>
                  perform(() => store.move(attachment, attachment.slot, attachment.order - 1))
                }
              >
                Up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="flex-1"
                aria-label={`Move ${title} later`}
                disabled={pending}
                onClick={() =>
                  perform(() => store.move(attachment, attachment.slot, attachment.order + 1))
                }
              >
                Down
              </Button>
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              aria-label={`Detach ${title}`}
              disabled={pending}
              onClick={() => perform(() => store.detach(attachment.id))}
            >
              Detach
            </Button>
          </PopoverContent>
        </Popover>
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
