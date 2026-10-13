import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useResolvedColorTheme } from "../lib/resolved-color-theme";
import { readWidgetTheme } from "../lib/widget-theme";
import { cn } from "@/lib/utils";
import type { CompiledInlineWidget } from "../../contracts/widgets/inline-widget-contract";
import { widgetDocumentUrl } from "../lib/widget-document-url";

/** Authoritative opaque-origin execution frame for compiled Cake widgets. */
export const InlineWidgetFrame = forwardRef<
  HTMLIFrameElement,
  {
    title: string;
    compiled: CompiledInlineWidget;
    className?: string;
    style?: CSSProperties;
    presentation?: "inline" | "workspace";
    /** Artifact-owned export controls may download generated local files. */
    downloads?: boolean;
  }
>(function InlineWidgetFrame(
  { title, compiled, className, style, presentation = "workspace", downloads = false },
  ref,
) {
  const colorScheme = useResolvedColorTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  // The initial theme is carried before first paint. Live changes are posted,
  // never assigned to src: reloading would erase widget interaction state.
  const [initial] = useState(() =>
    encodeURIComponent(JSON.stringify({ theme: readWidgetTheme(colorScheme), presentation })),
  );
  const postPresentation = useCallback(() => {
    frame.current?.contentWindow?.postMessage(
      {
        source: "cake-widget-host",
        token: compiled.token,
        type: "presentation",
        value: { theme: readWidgetTheme(colorScheme), presentation },
      },
      "*",
    );
  }, [colorScheme, compiled.token, presentation]);
  useEffect(postPresentation, [postPresentation]);
  useImperativeHandle(ref, () => frame.current!, [compiled.token]);
  const url = widgetDocumentUrl(compiled, window.location);
  if (!url) return null;
  const src = `${url}#cake-widget=${initial}`;
  return (
    <iframe
      ref={frame}
      onLoad={postPresentation}
      title={title}
      sandbox={downloads ? "allow-scripts allow-downloads" : "allow-scripts"}
      referrerPolicy="no-referrer"
      src={src}
      className={cn("w-full border-none", className)}
      style={style}
    />
  );
});
