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
    <div
      data-slot="workspace-companion-content"
      className={cn("flex min-h-0 flex-1 flex-col", !chat && "bg-sidebar")}
    >
      <div className="h-10 shrink-0 border-b border-border/65 bg-sidebar/30">
        <SegmentedControlGroup
          aria-label="Companion content"
          size="sm"
          className="h-full w-full items-stretch"
        >
          <SegmentedControlButton
            active={chat}
            onClick={() => navigator.showChat()}
            className="h-auto min-w-0 flex-1 basis-0"
            size="sm"
          >
            Chat
          </SegmentedControlButton>
          <SegmentedControlButton
            active={navigator.companionTab === "todos"}
            onClick={() => navigator.show("todos")}
            className="h-auto min-w-0 flex-1 basis-0"
            size="sm"
          >
            Todos
          </SegmentedControlButton>
          <SegmentedControlButton
            active={navigator.companionTab === "sessions"}
            onClick={() => navigator.show("sessions")}
            className="h-auto min-w-0 flex-1 basis-0"
            size="sm"
          >
            Sessions
          </SegmentedControlButton>
        </SegmentedControlGroup>
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", !chat && "hidden")}>{children}</div>
      {!chat && <WorkspaceNavigatorContent />}
    </div>
  );
});
