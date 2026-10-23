import { observer } from "r-state-tree/react";
import type { InlineWidgetStore } from "../stores/InlineWidgetStore";
import type { ProjectSessionStore } from "../stores/ProjectSessionStore";
import { Interview } from "./interview";

/** Keeps live interviews usable until their originating tool part is projected. */
export const BlockingInterviews = observer(function BlockingInterviews({
  session,
  inlineWidgets,
}: {
  session: ProjectSessionStore;
  inlineWidgets: InlineWidgetStore;
}) {
  const unlinked = session.interviews.filter(
    (interview) =>
      interview.requested &&
      !session.canonicalParts.some(
        (part) => part.kind === "tool" && part.interview?.id === interview.record.id,
      ),
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
