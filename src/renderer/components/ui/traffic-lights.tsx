import { cn } from "@/lib/utils";
import { IconButton } from "./icon-button";
import { CloseIcon, ExpandIcon, ShrinkIcon } from "./icons";

export interface TrafficLightsProps {
  /** Window title used to build tooltips and the group's accessible name. */
  title: string;
  /** Whether the window is currently maximized; swaps the maximize glyph and tooltip. */
  maximized: boolean;
  onClose(): void;
  onToggleMaximize(): void;
  className?: string;
}

/**
 * macOS-style window control lights for floating windows: red closes, green
 * toggles maximized. Glyphs reveal while hovering or focusing the group.
 */
export function TrafficLights({
  title,
  maximized,
  onClose,
  onToggleMaximize,
  className,
}: TrafficLightsProps) {
  const subject = title.toLowerCase();
  const lightClass =
    "size-3 rounded-full text-traffic-light-glyph hover:text-traffic-light-glyph [&_svg]:size-2";
  return (
    <div
      role="group"
      aria-label={`${title} window controls`}
      className={cn("group flex shrink-0 touch-none items-center gap-2", className)}
    >
      <IconButton
        tooltip={`Close ${subject}`}
        className={cn(lightClass, "bg-traffic-light-close hover:bg-traffic-light-close")}
        onClick={onClose}
      >
        <span
          aria-hidden="true"
          className="grid place-items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          <CloseIcon size={8} strokeWidth={3.2} />
        </span>
      </IconButton>
      <IconButton
        tooltip={maximized ? `Restore ${subject}` : `Maximize ${subject}`}
        className={cn(lightClass, "bg-traffic-light-maximize hover:bg-traffic-light-maximize")}
        onClick={onToggleMaximize}
      >
        <span
          aria-hidden="true"
          className="grid place-items-center opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {maximized ? (
            <ShrinkIcon size={8} strokeWidth={3.2} />
          ) : (
            <ExpandIcon size={8} strokeWidth={3.2} />
          )}
        </span>
      </IconButton>
    </div>
  );
}
