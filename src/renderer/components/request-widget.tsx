import { Option, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { cn } from "@/lib/utils";
import { observer } from "r-state-tree/react";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type { JsonValue } from "../../ipc/json-contract";
import type { CakeRequestView } from "../../ipc/request-contract";
import { inlineWidgetMessageSchema } from "../../utils/inline-widget-message";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";

export const RequestWidget = observer(function RequestWidget({
  artifact,
  view,
  requested,
  fallback,
  onSubmit,
  onSkip,
  store,
  fill = false,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "request" }>;
  view: Extract<CakeRequestView, { type: "widget" }>;
  requested: boolean;
  fallback: string;
  onSubmit?: (value: JsonValue) => void;
  onSkip?: () => void;
  store: InlineWidgetStore;
  fill?: boolean;
}) {
  const id = `${artifact.sessionId}:request:${artifact.id}:${artifact.revision}`;
  const state = store.state(id);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  useEffect(
    () => store.prepare(id, view.language, view.source, "request"),
    [id, store, view.language, view.source],
  );
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const parsed = Schema.decodeUnknownOption(inlineWidgetMessageSchema)(event.data);
      if (
        event.source !== iframe.current?.contentWindow ||
        !state?.compiled ||
        Option.isNone(parsed) ||
        parsed.value.token !== state.compiled.token
      )
        return;
      if (parsed.value.type === "height")
        setHeight(Math.max(120, Math.min(1_200, Math.ceil(parsed.value.value))));
      if (parsed.value.type === "error") store.reportRuntimeError(id, String(parsed.value.value));
      if (parsed.value.type === "submit") onSubmit?.(parsed.value.value);
      if (requested && parsed.value.type === "cancel") onSkip?.();
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [id, onSkip, onSubmit, requested, state?.compiled, store]);

  if (state?.status === "error") return <Markdown>{fallback}</Markdown>;
  if (!state?.compiled) return <div className="min-h-30" aria-busy="true" />;
  return (
    <iframe
      ref={iframe}
      title={artifact.title ?? artifact.id}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={state.compiled.url}
      className={cn("w-full border-none", fill && "h-full")}
      style={fill ? undefined : { height }}
    />
  );
});
