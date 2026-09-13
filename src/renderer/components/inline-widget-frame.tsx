import { forwardRef, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/** Authoritative opaque-origin execution frame for compiled Cake widgets. */
export const InlineWidgetFrame = forwardRef<
  HTMLIFrameElement,
  { title: string; src: string; className?: string; style?: CSSProperties }
>(function InlineWidgetFrame({ title, src, className, style }, ref) {
  return (
    <iframe
      ref={ref}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={src}
      className={cn("w-full border-none", className)}
      style={style}
    />
  );
});
