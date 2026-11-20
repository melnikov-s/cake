import type { ReactNode } from "react";
import { observer, useStore } from "r-state-tree/react";
import { WidgetTabPicker } from "./widget-tab-picker";
import { RootStore } from "../stores/RootStore";
import { cn } from "../lib/utils";
import { WorkspaceNavigatorContent } from "./workspace-navigator-content";

const companionTabClassName = (active: boolean) =>
  cn(
    "inline-flex h-7 min-w-0 shrink-0 items-center justify-center rounded-lg border px-2.5 text-xs whitespace-nowrap transition-colors outline-none select-none cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/40",
    active
      ? "border-accent/35 bg-accent/15 font-semibold text-accent"
      : "border-transparent font-medium text-muted-foreground hover:bg-foreground/[0.055] hover:text-foreground",
  );

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
      <div className="flex h-11 shrink-0 items-center justify-between gap-1.5 border-b border-hairline-subtle px-3.5">
        <div
          role="group"
          aria-label="Companion content"
          className="flex min-w-0 items-center gap-1"
        >
          <button
            type="button"
            aria-pressed={chat}
            onClick={() => navigator.showChat()}
            className={companionTabClassName(chat)}
          >
            Chat
          </button>
          <button
            type="button"
            aria-pressed={todos}
            onClick={() => navigator.show("todos")}
            className={companionTabClassName(todos)}
          >
            Todos
          </button>
          <button
            type="button"
            aria-pressed={sessions}
            onClick={() => navigator.show("sessions")}
            className={companionTabClassName(sessions)}
          >
            Sessions
          </button>
        </div>
        <WidgetTabPicker />
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", !chat && "hidden")}>{children}</div>
      {!chat && <WorkspaceNavigatorContent />}
    </div>
  );
});
