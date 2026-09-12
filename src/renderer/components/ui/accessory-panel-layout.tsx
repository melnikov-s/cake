import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ResizeHandle } from "@/components/ui/resize-handle";

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
  const style: CSSProperties & Record<"--accessory-panel-width", string> = {
    "--accessory-panel-width": `${panelWidth}px`,
  };

  return (
    <div
      ref={layoutRef}
      data-slot={dataSlot}
      data-presentation={open ? (sideBySide ? "side-by-side" : "replacement") : "closed"}
      className={
        open && sideBySide
          ? "grid h-full min-h-0 min-w-0 grid-cols-[minmax(0,1fr)_9px_var(--accessory-panel-width)] overflow-hidden"
          : "grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-1 overflow-hidden"
      }
      style={style}
    >
      <div
        className={
          open && !sideBySide
            ? "invisible pointer-events-none col-start-1 row-start-1 h-full min-h-0 min-w-0 overflow-hidden"
            : "h-full min-h-0 min-w-0 overflow-hidden"
        }
      >
        {children}
      </div>
      {open && sideBySide && (
        <div className="relative z-30 bg-border/35">
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
          className={
            sideBySide
              ? "min-h-0 min-w-0 overflow-hidden border-l border-border/65"
              : "col-start-1 row-start-1 min-h-0 min-w-0 overflow-hidden"
          }
        >
          {panel}
        </div>
      )}
    </div>
  );
}
