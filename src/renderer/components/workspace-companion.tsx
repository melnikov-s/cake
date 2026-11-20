import type { ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { WorkspaceTabStrip } from "./workspace-tab-strip";
import { ChatIcon, SessionsIcon, TodoIcon } from "./ui/icons";
import { RootStore } from "../stores/RootStore";
import { cn } from "../lib/utils";
import { WorkspaceNavigatorContent } from "./workspace-navigator-content";

/** Switch supporting surfaces without replacing the active browser/editor workspace. */
export const WorkspaceCompanion = observer(function WorkspaceCompanion({
  children,
}: {
  children: ReactNode;
}) {
  const navigator = useStore(RootStore).workspaceNavigatorStore;
  const chat = navigator.companionTab === "chat";
  const todos = !navigator.showingWidget && navigator.companionTab === "todos";
  const sessions = !navigator.showingWidget && navigator.companionTab === "sessions";
  return (
    <div
      data-slot="workspace-companion-content"
      className={cn("flex min-h-0 flex-1 flex-col", !chat && "bg-inspector")}
    >
      <div className="flex h-11 shrink-0 items-center border-b border-hairline-subtle px-3.5">
        <WorkspaceTabStrip
          label="Companion content"
          tabs={[
            {
              id: "chat",
              label: "Chat",
              icon: <ChatIcon />,
              active: chat,
              onSelect: () => navigator.showChat(),
            },
            {
              id: "todos",
              label: "Todos",
              icon: <TodoIcon />,
              active: todos,
              onSelect: () => navigator.show("todos"),
            },
            {
              id: "sessions",
              label: "Sessions",
              icon: <SessionsIcon />,
              active: sessions,
              onSelect: () => navigator.show("sessions"),
            },
          ]}
        />
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", !chat && "hidden")}>{children}</div>
      {!chat && <WorkspaceNavigatorContent />}
    </div>
  );
});
