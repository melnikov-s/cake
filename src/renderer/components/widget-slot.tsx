import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  const [available, setAvailable] = useState(0);
  const [resizing, setResizing] = useState(false);
  const element = useRef<HTMLElement>(null);
  const attachments = store.forSession(session.sessionId, session.kind, slot);
  useLayoutEffect(() => {
    const panel = element.current;
    const container = panel?.parentElement;
    if (!panel || !container) return;
    const siblings = [...container.children].filter(
      (child) => child !== panel && child.hasAttribute("data-widget-slot"),
    );
    const measure = () => {
      const rect = container.getBoundingClientRect();
      const occupied = siblings.reduce((sum, sibling) => {
        const rect = sibling.getBoundingClientRect();
        return sum + (side ? rect.width : rect.height);
      }, 0);
      setAvailable(Math.max(0, (side ? rect.width : rect.height) - occupied));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const sibling of siblings) observer.observe(sibling);
    measure();
    return () => observer.disconnect();
  });
  if (attachments.length === 0) return null;
  const value = Math.min(size, available);
  return (
    <section
      ref={element}
      aria-label={`${slot} widgets`}
      data-widget-slot={slot}
      className={cn(
        "relative min-h-0 min-w-0 shrink-0 overflow-hidden bg-background",
        side ? "h-full border-x border-border/65" : "border-y border-border/65",
        resizing && "select-none",
      )}
      style={side ? { width: value } : { height: value }}
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
        value={value}
        min={0}
        max={available}
        edge={slot}
        onChange={setSize}
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
