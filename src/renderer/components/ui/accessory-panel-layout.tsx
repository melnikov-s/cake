import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { cn } from "@/lib/utils";

const SIDE_BY_SIDE_MIN_WIDTH = 860;
const MIN_PANEL_WIDTH = 320;

/** Responsive parent-surface accessory: right-hand panel when wide, replacement when narrow. */
export function AccessoryPanelLayout({
  open,
  width,
  resizeLabel,
  children,
  panel,
  onWidthChange,
  dataSlot = "accessory-panel-layout",
}: {
  open: boolean;
  width: number;
  resizeLabel: string;
  children: ReactNode;
  panel: ReactNode;
  onWidthChange(width: number): void;
  dataSlot?: string;
}) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useLayoutEffect(() => {
    const layout = layoutRef.current;
    if (!layout) return;
    const update = () => setAvailableWidth(layout.getBoundingClientRect().width);
    update();
    if (!("ResizeObserver" in globalThis)) return;
    const resizeObserver = new globalThis.ResizeObserver(update);
    resizeObserver.observe(layout);
    return () => resizeObserver.disconnect();
  }, []);

  const sideBySide = open && availableWidth >= SIDE_BY_SIDE_MIN_WIDTH;
  const maximumWidth = Math.max(MIN_PANEL_WIDTH, availableWidth * 0.6);
  const panelWidth = Math.min(maximumWidth, Math.max(MIN_PANEL_WIDTH, width));
  const style: CSSProperties &
    Record<"--accessory-panel-width" | "--accessory-divider-width", string> = {
    "--accessory-panel-width": sideBySide ? `${panelWidth}px` : "0px",
    "--accessory-divider-width": sideBySide ? "9px" : "0px",
  };

  return (
    <div
      ref={layoutRef}
      data-slot={dataSlot}
      data-presentation={open ? (sideBySide ? "side-by-side" : "replacement") : "closed"}
      className={cn(
        "grid h-full min-h-0 min-w-0 overflow-hidden",
        sideBySide
          ? "grid-cols-[minmax(0,1fr)_var(--accessory-divider-width)_var(--accessory-panel-width)]"
          : "grid-cols-1 grid-rows-1",
      )}
      style={style}
    >
      <div
        inert={open && !sideBySide}
        className={
          open && !sideBySide
            ? "invisible pointer-events-none col-start-1 row-start-1 h-full min-h-0 min-w-0 overflow-hidden"
            : "col-start-1 row-start-1 h-full min-h-0 min-w-0 overflow-hidden"
        }
      >
        {children}
      </div>
      {open && sideBySide && (
        <div className="relative z-30 col-start-2 row-start-1 bg-border/35">
          <ResizeHandle
            className="inset-0 h-full w-full"
            label={resizeLabel}
            value={panelWidth}
            min={MIN_PANEL_WIDTH}
            max={maximumWidth}
            edge="right"
            onChange={onWidthChange}
          />
        </div>
      )}
      {open && (
        <div
          className={cn(
            "min-h-0 min-w-0 overflow-hidden",
            sideBySide ? "col-start-3 row-start-1" : "col-start-1 row-start-1",
            sideBySide && "border-l border-border/65",
          )}
        >
          {panel}
        </div>
      )}
    </div>
  );
}
