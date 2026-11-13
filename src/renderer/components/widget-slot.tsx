import { useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { observer } from "r-state-tree/react";
import type { WidgetSlot as Slot } from "../../contracts/widgets/widget-attachment";
import type { ArtifactNavigationContext } from "../../contracts/artifacts/artifact-navigation-context";
import type { WidgetAttachmentStore } from "../stores/WidgetAttachmentStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { WidgetAttachment } from "./widget-attachment";
import { ResizeHandle } from "./ui/resize-handle";
import { cn } from "../lib/utils";
import { useWidgetSlotLayout } from "./widget-slot-layout";

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
  const layout = useWidgetSlotLayout();
  const [resizing, setResizing] = useState(false);
  const attachments = store.forSession(session.sessionId, session.kind, slot);
  const present = attachments.length > 0;
  const { register } = layout;
  useLayoutEffect(() => {
    register(slot, present);
    return () => register(slot, false);
  }, [register, slot, present]);
  if (!present) return null;
  const value = layout.sizes[slot];
  const available = side ? layout.width : layout.height;
  return (
    <section
      aria-label={`${slot} widgets`}
      data-widget-slot={slot}
      className={cn(
        "relative min-h-0 min-w-0 shrink-0 bg-background",
        side && "h-full",
        resizing && "select-none",
      )}
      style={side ? { width: value } : { height: value }}
    >
      <div
        className={cn(
          "h-full overflow-auto overscroll-contain",
          value > 0 && (side ? "border-x border-border/65" : "border-y border-border/65"),
        )}
      >
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
            ? value === 0
              ? "left-0"
              : "-right-1"
            : slot === "right"
              ? value === 0
                ? "right-0"
                : "-left-1"
              : slot === "top"
                ? value === 0
                  ? "top-0"
                  : "-bottom-1"
                : value === 0
                  ? "bottom-0"
                  : "-top-1"
        }
        label={`Resize ${slot} widgets`}
        value={value}
        min={0}
        max={available}
        edge={slot}
        onChange={(size) => layout.resize(slot, size)}
        onResizeStart={() => setResizing(true)}
        onResizeEnd={() => setResizing(false)}
      />
      {resizing &&
        createPortal(
          <div
            data-widget-resize-overlay
            className={cn(
              "fixed inset-0 z-[100] select-none touch-none",
              side ? "cursor-col-resize" : "cursor-row-resize",
            )}
          />,
          document.body,
        )}
    </section>
  );
});
