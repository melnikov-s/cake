import { observer } from "r-state-tree/react";
import { Markdown } from "@/components/ai-elements/markdown";
import type { InterviewStore } from "../stores/InterviewStore";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import { InterviewForm } from "./interview-form";
import { InterviewWidget } from "./interview-widget";
import { Callout } from "./ui/callout";
import { DictationIndicatorContext } from "../dictation/dictation-indicator-context";

export const Interview = observer(function Interview({
  store,
  inlineWidgets,
}: {
  store: InterviewStore;
  inlineWidgets?: InlineWidgetStore;
}) {
  const request = store.record.request;
  return (
    <DictationIndicatorContext.Provider value={undefined}>
      <article className="relative min-w-0" data-interview-id={store.record.id}>
        {store.error && <Callout variant="error">{store.error}</Callout>}
        {store.cancelled ? (
          <p role="status" className="text-sm text-muted-foreground">
            Skipped
          </p>
        ) : request.view.type === "form" ? (
          <InterviewForm store={store} />
        ) : store.submitted ? (
          <p role="status" className="text-sm text-foreground">
            Submitted
          </p>
        ) : inlineWidgets ? (
          <InterviewWidget interview={store} store={inlineWidgets} />
        ) : (
          <Markdown>{request.fallback.markdown}</Markdown>
        )}
      </article>
    </DictationIndicatorContext.Provider>
  );
});
