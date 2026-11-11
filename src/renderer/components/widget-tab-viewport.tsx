import { useContext } from "react";
import { WidgetTabViewportContext } from "../lib/widget-tab-viewport-context";

export function WidgetTabViewport() {
  const place = useContext(WidgetTabViewportContext);
  return <div ref={place} data-slot="widget-tab-viewport" className="min-h-0 min-w-0 flex-1" />;
}
