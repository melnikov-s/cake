import { useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";
import type { ProvisionalTextSpan } from "../../dictation/provisional-text";
import { cn } from "../../lib/utils";

type Geometry = {
  frame: Pick<CSSProperties, "top" | "left" | "width" | "height">;
  content: Pick<
    CSSProperties,
    "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "textIndent" | "transform"
  >;
};

/** Decorative native-textarea mirror. The actual textarea owns editing, selection and accessibility. */
export function TextareaProvisionalText({
  anchor,
  span,
  className,
}: {
  anchor: RefObject<HTMLTextAreaElement | null>;
  span: ProvisionalTextSpan;
  className: string;
}) {
  const [geometry, setGeometry] = useState<Geometry>();
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const measure = () => {
      const style = getComputedStyle(element);
      setGeometry({
        frame: {
          top: element.clientTop,
          left: element.clientLeft,
          width: element.clientWidth,
          height: element.clientHeight,
        },
        content: {
          paddingTop: style.paddingTop,
          paddingRight: style.paddingRight,
          paddingBottom: style.paddingBottom,
          paddingLeft: style.paddingLeft,
          textIndent: style.textIndent,
          transform: `translate(${-element.scrollLeft}px, ${-element.scrollTop}px)`,
        },
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener("scroll", measure);
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", measure);
    };
  }, [anchor, span.value, className]);
  return (
    <div
      aria-hidden="true"
      data-slot="textarea-provisional-overlay"
      className="pointer-events-none absolute overflow-hidden"
      style={geometry?.frame}
    >
      <div
        className={cn(
          className,
          "block h-auto min-h-0 max-h-none whitespace-pre-wrap break-words border-0 bg-transparent text-foreground outline-none ring-0",
        )}
        style={geometry?.content}
      >
        {span.value.slice(0, span.start)}
        <span data-slot="provisional-text" className="text-muted-foreground">
          {span.value.slice(span.start, span.end)}
        </span>
        {span.value.slice(span.end)}
        {/* A trailing newline must occupy a line just as it does in the native textarea. */}
        {span.value.endsWith("\n") ? "\u200b" : null}
      </div>
    </div>
  );
}
