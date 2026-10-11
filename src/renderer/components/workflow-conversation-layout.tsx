import type { ReactNode } from "react";
import { observer } from "r-state-tree/react";
import { WorkflowDetail } from "./workflow-detail";
import type { WorkflowRunStore } from "../stores/WorkflowRunStore";

/** Optional inspection beside the existing Chat, never another conversation mode. */
export const WorkflowConversationLayout = observer(function WorkflowConversationLayout({
  stores,
  children,
}: {
  stores: readonly WorkflowRunStore[];
  children: ReactNode;
}) {
  const selected = stores.find((store) => store.selectedRunId);
  return (
    <div className="flex h-full min-h-0 min-w-0">
      <div className="min-h-0 min-w-0 flex-1">{children}</div>
      {selected && (
        <div className="h-full min-h-0 w-[420px] max-w-[55%] shrink-0 border-l border-border">
          <WorkflowDetail store={selected} />
        </div>
      )}
    </div>
  );
});
