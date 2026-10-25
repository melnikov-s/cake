import { observer } from "r-state-tree/react";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { InterviewStore } from "../stores/InterviewStore";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { Interview } from "./interview";

/** Keeps live interviews usable until their originating tool part is projected. */
export const BlockingInterviews = observer(function BlockingInterviews({
  interviews,
  parts,
  inlineWidgets,
}: {
  interviews: readonly InterviewStore[];
  parts: readonly UiPart[];
  inlineWidgets: InlineWidgetStore;
}) {
  const unlinked = interviews.filter(
    (interview) =>
      interview.requested &&
      !parts.some((part) => part.kind === "tool" && part.interview?.id === interview.record.id),
  );
  if (!unlinked.length) return null;
  return (
    <div className="max-h-[min(50vh,28rem)] overflow-auto px-1 pb-2 *:motion-safe:animate-arrive">
      {unlinked.map((store) => (
        <Interview key={store.record.id} store={store} inlineWidgets={inlineWidgets} />
      ))}
    </div>
  );
});
