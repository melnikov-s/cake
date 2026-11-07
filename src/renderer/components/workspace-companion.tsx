import type { ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { cn } from "../lib/utils";
import { SegmentedControlButton, SegmentedControlGroup } from "./ui/segmented-control";
import { WorkspaceNavigatorContent } from "./workspace-navigator-content";

/** Switch supporting surfaces without replacing the active browser/editor workspace. */
export const WorkspaceCompanion = observer(function WorkspaceCompanion({
  children,
}: {
  children: ReactNode;
}) {
  const navigator = useStore(RootStore).workspaceNavigatorStore;
  const chat = navigator.companionTab === "chat";
  return (
    <>
      <div className="shrink-0 border-b border-border/65 bg-sidebar/30 px-2 py-2">
        <SegmentedControlGroup aria-label="Companion content" size="sm" className="w-full">
          <SegmentedControlButton
            active={chat}
            onClick={() => navigator.showChat()}
            className="flex-1"
            size="sm"
          >
            Chat
          </SegmentedControlButton>
          <SegmentedControlButton
            active={navigator.companionTab === "todos"}
            onClick={() => navigator.show("todos")}
            className="flex-1"
            size="sm"
          >
            Todos
          </SegmentedControlButton>
          <SegmentedControlButton
            active={navigator.companionTab === "sessions"}
            onClick={() => navigator.show("sessions")}
            className="flex-1"
            size="sm"
          >
            Sessions
          </SegmentedControlButton>
        </SegmentedControlGroup>
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", !chat && "hidden")}>{children}</div>
      {!chat && <WorkspaceNavigatorContent />}
    </>
  );
});
