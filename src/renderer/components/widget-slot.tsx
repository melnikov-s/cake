import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { WidgetSlot as Slot } from "../../contracts/widgets/widget-attachment";
import type { ArtifactNavigationContext } from "../../contracts/artifacts/artifact-navigation-context";
import type { WidgetAttachmentStore } from "../stores/WidgetAttachmentStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { WidgetAttachment } from "./widget-attachment";
import { ResizeHandle } from "./ui/resize-handle";
import { cn } from "../lib/utils";

export const WidgetSlot = observer(function WidgetSlot({
  slot,
  session,
  store,
  widgets,
}: {
  slot: Exclude<Slot, "tab">;
  session: NonNullable<ArtifactNavigationContext["session"]>;
  store: WidgetAttachmentStore;
  widgets: InlineWidgetStore;
}) {
  const side = slot === "left" || slot === "right";
  const [size, setSize] = useState(side ? 280 : 160);
  const [resizing, setResizing] = useState(false);
  const attachments = store.forSession(session.sessionId, session.kind, slot);
  if (attachments.length === 0) return null;
  return (
    <section
      aria-label={`${slot} widgets`}
      data-widget-slot={slot}
      className={cn(
        "relative min-h-0 min-w-0 shrink-0 overflow-hidden bg-background",
        side
          ? "h-full max-w-[30%] border-x border-border/65"
          : "max-h-[30vh] border-y border-border/65",
        resizing && "select-none [&_iframe]:pointer-events-none",
      )}
      style={side ? { width: size } : { height: size }}
    >
      <div className="h-full overflow-auto overscroll-contain">
        {attachments.map((attachment) => (
          <WidgetAttachment
            key={attachment.id}
            attachment={attachment}
            store={store}
            widgets={widgets}
            session={session}
          />
        ))}
      </div>
      <ResizeHandle
        className={
          slot === "left"
            ? "right-0"
            : slot === "right"
              ? "left-0"
              : slot === "top"
                ? "bottom-0"
                : "top-0"
        }
        label={`Resize ${slot} widgets`}
        value={size}
        min={side ? 160 : 64}
        max={side ? 520 : 400}
        edge={
          slot === "left" ? "left" : slot === "right" ? "right" : slot === "top" ? "top" : "bottom"
        }
        onChange={setSize}
        onResizeStart={() => setResizing(true)}
        onResizeEnd={() => setResizing(false)}
      />
    </section>
  );
});
