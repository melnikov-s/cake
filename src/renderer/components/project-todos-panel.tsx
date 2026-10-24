import { observer } from "r-state-tree/react";
import { AnimatedList } from "@/components/ui/animated-list";
import { Callout } from "@/components/ui/callout";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { ProjectTodoItem } from "./project-todo-item";

export const ProjectTodosPanel = observer(function ProjectTodosPanel({
  store,
}: {
  store: ProjectTodosStore;
}) {
  const openItems = store.filteredOpenItems;
  const doneItems = store.filteredDoneItems;
  const searching = Boolean(store.query.trim());
  const noResults = searching && !openItems.length && !doneItems.length;
  return (
    <div className="h-full overflow-y-auto px-3 pb-4 pt-4">
      <div className="mb-3 px-3">
        <h2 className="text-xs font-semibold">
          Open{" "}
          <span className="ml-1 font-normal tabular-nums text-muted-foreground">
            {openItems.length}
          </span>
        </h2>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Select a thread to give your next message context.
        </p>
      </div>
      {store.error && (
        <Callout variant="error" role="alert">
          {store.error}
        </Callout>
      )}
      {openItems.length ? (
        <AnimatedList as="ul" aria-label="Open to-dos" className="space-y-2">
          {openItems.map((item) => (
            <ProjectTodoItem key={item.id} item={item} store={store} />
          ))}
        </AnimatedList>
      ) : (
        <p role="status" className="px-1 py-4 text-sm text-muted-foreground">
          {noResults
            ? "No matching to-dos. Try another search or clear it."
            : searching
              ? "No matching open to-dos."
              : "No open to-dos. Your agent can add a thread when taking on a commitment."}
        </p>
      )}
      {doneItems.length > 0 && (
        <section className="mt-4 border-t border-border px-1 pt-2">
          <DisclosureTrigger
            title={`Done (${doneItems.length})`}
            open={store.doneExpanded}
            onClick={() => store.toggleDone()}
          />
          {store.doneExpanded && (
            <AnimatedList as="ul" aria-label="Done to-dos" className="mt-2 space-y-1">
              {doneItems.map((item) => (
                <ProjectTodoItem key={item.id} item={item} store={store} />
              ))}
            </AnimatedList>
          )}
        </section>
      )}
    </div>
  );
});
