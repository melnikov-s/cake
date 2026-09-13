import { Option, Schema } from "effect";
import { useEffect, useRef } from "react";
import { observer, useStore } from "r-state-tree/react";
import { inlineWidgetMessageSchema } from "../../utils/inline-widget-message";
import { WidgetPreviewStore } from "../stores/WidgetPreviewStore";

/** Trusted transient host for main-requested visual review of a compiled sandbox widget. */
export const WidgetPreviewHost = observer(function WidgetPreviewHost() {
  const store = useStore(WidgetPreviewStore);
  const preview = store.preview;
  const iframe = useRef<HTMLIFrameElement>(null);
  const reportedHeight = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!preview) return;
    const receive = (event: MessageEvent) => {
      const parsed = Schema.decodeUnknownOption(inlineWidgetMessageSchema)(event.data);
      if (
        event.source !== iframe.current?.contentWindow ||
        Option.isNone(parsed) ||
        parsed.value.token !== preview.widget.token
      )
        return;
      if (parsed.value.type === "height") {
        reportedHeight.current = parsed.value.value;
        return;
      }
      if (parsed.value.type === "error") {
        store.fail(preview.widget.token, String(parsed.value.value).slice(0, 2_000));
        return;
      }
      if (parsed.value.type !== "ready") return;
      void (async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        const frame = iframe.current;
        if (!frame || store.preview?.widget.token !== preview.widget.token) return;
        const bounds = frame.getBoundingClientRect();
        store.ready(
          preview.widget.token,
          {
            x: Math.floor(bounds.x),
            y: Math.floor(bounds.y),
            width: Math.ceil(bounds.width),
            height: Math.ceil(bounds.height),
          },
          [
            `viewport=${window.innerWidth}x${window.innerHeight}`,
            `widget=${Math.ceil(bounds.width)}x${Math.ceil(bounds.height)}`,
            `contentHeight=${Math.ceil(reportedHeight.current ?? bounds.height)}`,
            `verticalOverflow=${(reportedHeight.current ?? bounds.height) > bounds.height}`,
            `deviceScaleFactor=${window.devicePixelRatio}`,
          ],
        );
      })();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [preview, store]);

  if (!preview) return null;
  return (
    <div className="fixed bottom-3 right-3 z-50 h-[min(480px,calc(100vh-24px))] w-[min(560px,calc(100vw-24px))] overflow-hidden rounded-lg bg-background shadow-xl ring-1 ring-border">
      <iframe
        ref={iframe}
        title="Widget visual review preview"
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={preview.widget.url}
        className="h-full w-full border-none"
      />
    </div>
  );
});
