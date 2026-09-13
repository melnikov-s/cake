import { Option, Schema } from "effect";
import { useEffect, useRef } from "react";
import { observer } from "r-state-tree/react";
import { inlineWidgetMessageSchema } from "../../utils/inline-widget-message";
import type { WidgetPreviewStore } from "../stores/WidgetPreviewStore";
import { FullscreenSurface } from "./fullscreen-surface";
import { InlineWidgetFrame } from "./inline-widget-frame";

/** Trusted transient host for main-requested visual review of a compiled sandbox widget. */
export const WidgetPreviewHost = observer(function WidgetPreviewHost({
  store,
}: {
  store: WidgetPreviewStore;
}) {
  const preview = store.preview;
  const iframe = useRef<HTMLIFrameElement>(null);
  const reportedHeight = useRef<number | undefined>(undefined);

  useEffect(() => {
    reportedHeight.current = undefined;
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
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [preview, store]);

  if (!preview) return null;
  return (
    <FullscreenSurface
      mode="dialog"
      eyebrow="Widget specialist"
      title="Reviewing rendered widget"
      onClose={() => store.cancel()}
    >
      <div className="flex w-full flex-col gap-3 rounded-xl border border-border bg-card p-3 shadow-2xl">
        <p className="text-xs text-muted-foreground">
          Cake is rendering the candidate at artifact-panel width before publication.
        </p>
        <InlineWidgetFrame
          ref={iframe}
          title="Widget visual review preview"
          src={preview.widget.url}
          className="h-[min(480px,calc(100vh-12rem))]"
        />
      </div>
    </FullscreenSurface>
  );
});
