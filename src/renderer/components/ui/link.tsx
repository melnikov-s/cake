import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { TooltipBubble, useTooltip } from "./tooltip";

export type LinkProps = ComponentProps<"a">;

/** Shared inline navigation, independent of the destination's owning surface. */
export function Link({
  className,
  href,
  title,
  children,
  onMouseEnter,
  onMouseLeave,
  onMouseDown,
  onFocus,
  onBlur,
  onClick,
  ...props
}: LinkProps) {
  const { anchor, hide, show } = useTooltip();
  const destination = title ?? href;
  return (
    <>
      <a
        {...props}
        href={href}
        aria-description={destination}
        className={cn(
          "cursor-pointer font-semibold text-inherit underline decoration-solid decoration-current underline-offset-4 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
        onMouseEnter={(event) => {
          if (destination) show(event.currentTarget);
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          hide();
          onMouseLeave?.(event);
        }}
        onMouseDown={(event) => {
          hide();
          onMouseDown?.(event);
        }}
        onFocus={(event) => {
          if (destination && event.currentTarget.matches(":focus-visible"))
            show(event.currentTarget);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          hide();
          onBlur?.(event);
        }}
        onClick={(event) => {
          hide();
          onClick?.(event);
        }}
      >
        {children}
      </a>
      {destination && anchor && <TooltipBubble label={destination} anchor={anchor} wrap />}
    </>
  );
}
