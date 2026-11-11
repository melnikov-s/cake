import { useLayoutEffect, useState, type ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { WidgetTabViewportContext } from "../lib/widget-tab-viewport-context";
import { WidgetAttachment } from "./widget-attachment";
import { cn } from "../lib/utils";

/** One stable host per window, outside conversation and accessory lifetimes.
 * Geometry follows the visible pane, without reparenting/reloading its iframes.
 * Unselected widgets keep their existing bridge resources; no transcript is loaded.
 */
export const WidgetTabHost = observer(function WidgetTabHost({
  children,
}: {
  children: ReactNode;
}) {
  const root = useStore(RootStore);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<Pick<DOMRect, "left" | "top" | "width" | "height">>();
  useLayoutEffect(() => {
    if (!target) {
      setBounds(undefined);
      return;
    }
    const measure = () => {
      const { left, top, width, height } = target.getBoundingClientRect();
      setBounds({ left, top, width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    // Ancestors can move the pane without resizing the pane itself (rail/tool changes).
    for (let element: Element | null = target; element; element = element.parentElement)
      observer.observe(element);
    window.addEventListener("resize", measure);
    document.addEventListener("scroll", measure, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      document.removeEventListener("scroll", measure, true);
    };
  }, [target]);
  const navigator = root.workspaceNavigatorStore;
  const selected = navigator.showingWidget ? navigator.selectedWidget : undefined;
  const session = root.inlineWidgetStore.navigationContext?.session ?? null;
  return (
    <WidgetTabViewportContext value={setTarget}>
      {children}
      <div
        data-slot="widget-tab-host"
        className={cn(
          "fixed z-20 min-h-0 min-w-0 overflow-hidden bg-sidebar text-sidebar-foreground",
          (!target || !bounds || !selected) && "hidden",
        )}
        style={bounds}
      >
        {root.widgetAttachmentStore.tabWidgets.map((attachment) => (
          <div
            key={attachment.id}
            className={cn("h-full min-h-0 min-w-0", selected?.id !== attachment.id && "hidden")}
            aria-hidden={selected?.id !== attachment.id}
            inert={selected?.id !== attachment.id}
          >
            <WidgetAttachment
              attachment={attachment}
              store={root.widgetAttachmentStore}
              widgets={root.inlineWidgetStore}
              session={session}
            />
          </div>
        ))}
      </div>
    </WidgetTabViewportContext>
  );
});
