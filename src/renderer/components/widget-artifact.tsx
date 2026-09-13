import { Option, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { observer } from "r-state-tree/react";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import { inlineWidgetMessageSchema } from "../../utils/inline-widget-message";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { InlineWidgetFrame } from "./inline-widget-frame";

export const WidgetArtifact = observer(function WidgetArtifact({
  artifact,
  inlineWidgets,
  fill = false,
}: {
  artifact: Extract<CakeArtifactV1, { kind: "widget" }>;
  inlineWidgets?: InlineWidgetStore;
  fill?: boolean;
}) {
  const id = `${artifact.sessionId}:widget:${artifact.id}:${artifact.revision}`;
  const state = inlineWidgets?.state(id);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  useEffect(() => {
    if (inlineWidgets)
      inlineWidgets.prepare(id, artifact.payload.language, artifact.payload.source);
  }, [artifact.payload.language, artifact.payload.source, id, inlineWidgets]);
  useEffect(() => {
    if (!inlineWidgets) return;
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
      if (parsed.value.type === "error")
        inlineWidgets.reportRuntimeError(id, String(parsed.value.value));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [id, inlineWidgets, state?.compiled]);

  if (!inlineWidgets || state?.status === "error")
    return <Markdown>{artifact.fallback.markdown}</Markdown>;
  if (!state?.compiled) return <div className="min-h-30" aria-busy="true" />;
  return (
    <InlineWidgetFrame
      ref={iframe}
      className={fill ? "h-full" : undefined}
      title={artifact.title ?? artifact.id}
      src={state.compiled.url}
      style={fill ? undefined : { height }}
    />
  );
});
