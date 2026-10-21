import { observer } from "r-state-tree/react";
import { Callout } from "@/components/ui/callout";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { ProjectTodoItem } from "./project-todo-item";

export const ProjectTodosPanel = observer(function ProjectTodosPanel({
  store,
}: {
  store: ProjectTodosStore;
}) {
  return (
    <div className="h-full overflow-y-auto px-3 pb-4 pt-4">
      <div className="mb-3 px-3">
        <h2 className="text-xs font-semibold">
          Open{" "}
          <span className="ml-1 font-normal tabular-nums text-muted-foreground">
            {store.openItems.length}
          </span>
        </h2>
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Select a thread to give your next message context.
        </p>
      </div>
      {store.error && (
        <Callout variant="error" role="alert">
          {store.error}
        </Callout>
      )}
      {store.openItems.length ? (
        <ul aria-label="Open to-dos" className="space-y-2">
          {store.openItems.map((item) => (
            <ProjectTodoItem key={item.id} item={item} store={store} />
          ))}
        </ul>
      ) : (
        <p className="px-1 py-4 text-sm text-muted-foreground">
          No open to-dos. Your agent can add a thread when taking on a commitment.
        </p>
      )}
      {store.doneItems.length > 0 && (
        <section className="mt-4 border-t border-border px-1 pt-2">
          <DisclosureTrigger
            title={`Done (${store.doneItems.length})`}
            open={store.doneExpanded}
            onClick={() => store.toggleDone()}
          />
          {store.doneExpanded && (
            <ul aria-label="Done to-dos" className="mt-2 space-y-1">
              {store.doneItems.map((item) => (
                <ProjectTodoItem key={item.id} item={item} store={store} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
});
