import { forwardRef, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import type { CompiledInlineWidget } from "../../ipc/inline-widget-contract";
import { widgetDocumentUrl } from "../lib/widget-document-url";

/** Authoritative opaque-origin execution frame for compiled Cake widgets. */
export const InlineWidgetFrame = forwardRef<
  HTMLIFrameElement,
  { title: string; compiled: CompiledInlineWidget; className?: string; style?: CSSProperties }
>(function InlineWidgetFrame({ title, compiled, className, style }, ref) {
  const src = widgetDocumentUrl(compiled, window.location);
  if (!src) return null;
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
