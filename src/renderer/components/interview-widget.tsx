import { Option, Schema } from "effect";
import { useEffect, useRef, useState } from "react";
import { Markdown } from "@/components/ai-elements/markdown";
import { observer } from "r-state-tree/react";
import type { InterviewStore } from "../stores/InterviewStore";
import { inlineWidgetMessageSchema } from "../../utils/inline-widget-message";
import { InlineWidgetFrame } from "./inline-widget-frame";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";

export const InterviewWidget = observer(function InterviewWidget({
  interview,
  store,
}: {
  interview: InterviewStore;
  store: InlineWidgetStore;
}) {
  const view = interview.record.request.view;
  const id = `${interview.record.sessionId}:interview:${interview.record.id}`;
  const state = store.state(id);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(220);
  useEffect(() => {
    if (view.type === "widget") store.prepare(id, view.language, view.source, "request");
  }, [id, store, view]);
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
      if (parsed.value.type === "submit") void interview.respond(parsed.value.value);
      if (interview.requested && parsed.value.type === "cancel")
        void interview.respond(undefined, true);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [id, interview, state?.compiled, store]);

  if (state?.status === "error")
    return <Markdown>{interview.record.request.fallback.markdown}</Markdown>;
  if (!state?.compiled) return <div className="min-h-30" aria-busy="true" />;
  return (
    <InlineWidgetFrame
      ref={iframe}
      title={interview.record.request.title}
      compiled={state.compiled}
      className="w-full border-none"
      style={{ height }}
    />
  );
});
