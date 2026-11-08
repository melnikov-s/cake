import { useEffect, useLayoutEffect, useRef } from "react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { AnimatedList } from "@/components/ui/animated-list";
import { Callout } from "@/components/ui/callout";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { AutoMergeToggle } from "./auto-merge-toggle";
import { cn } from "@/lib/utils";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { ProjectTodoItem } from "./project-todo-item";

export const ProjectTodosPanel = observer(function ProjectTodosPanel({
  store,
}: {
  store: ProjectTodosStore;
}) {
  const root = useStore(RootStore);
  const projectPath = store.source?.scope;
  const allowsCakeMerge =
    !projectPath ||
    root.projectCatalogStore.find(projectPath)?.settings.worktreeLanding !== "pull-request";
  const pane = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void store.reconcile();
  }, [store]);
  // Only explicit row actions may scroll or restore keyboard focus after a section move.
  // Mounting, filtering and authority updates must not replay an old request.
  const request = store.paneRequest;
  useLayoutEffect(() => {
    if (!request) return;
    const element = pane.current;
    if (!element) return;
    store.completePaneRequest();
    const row = Array.from(element.querySelectorAll<HTMLElement>("[data-todo-id]")).find(
      (candidate) => candidate.dataset.todoId === request.id,
    );
    if (request.focus)
      row?.querySelector<HTMLButtonElement>("[aria-pressed]")?.focus({ preventScroll: true });
    if (request.scroll === "nearest") row?.scrollIntoView?.({ block: "nearest" });
    if (request.scroll === "top") {
      element.scrollTo?.({
        top: 0,
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "instant"
          : "smooth",
      });
    }
  }, [request, store]);
  const searching = Boolean(store.query.trim());
  const sections = [
    { title: "Focus", items: store.filteredFocusedItems, open: true },
    { title: "Needs attention", items: store.filteredAttentionItems, open: true },
    {
      title: allowsCakeMerge ? "Ready to Merge" : "Ready",
      items: store.filteredReadyItems,
      open: store.readyExpanded,
      toggle: () => store.toggleReady(),
    },
    {
      title: "Active",
      items: store.filteredActiveItems,
      open: store.activeExpanded,
      toggle: () => store.toggleActive(),
    },
    {
      title: "Snoozed",
      items: store.filteredSnoozedItems,
      open: store.snoozedExpanded,
      toggle: () => store.toggleSnoozed(),
    },
    {
      title: "Done",
      items: store.filteredDoneItems,
      open: store.doneExpanded,
      toggle: () => store.toggleDone(),
    },
  ].filter((section) => section.items.length > 0);
  return (
    <div
      ref={pane}
      data-slot="todo-scroll-pane"
      className="h-full overflow-y-auto [overflow-anchor:none] px-3 pb-4 pt-4"
    >
      {store.error && (
        <Callout variant="error" role="alert">
          {store.error}
        </Callout>
      )}
      {allowsCakeMerge && store.filteredReadyItems.length === 0 && (
        <div className="mb-3 flex items-center justify-between gap-2 px-1 text-xs text-muted-foreground">
          <span>Auto-merge</span>
          <AutoMergeToggle projectPath={projectPath} />
        </div>
      )}
      <AnimatedList nested animateRemovals>
        {sections.map((section, index) => (
          <section
            key={section.title}
            aria-label={section.title}
            className={cn(
              section.toggle && "px-1",
              index > 0 && "mt-4 border-t border-border pt-2",
            )}
          >
            {section.toggle ? (
              <div className="flex items-center gap-3">
                <DisclosureTrigger
                  title={`${section.title} (${section.items.length})`}
                  open={section.open}
                  onClick={section.toggle}
                />
                {section.title === "Ready to Merge" && (
                  <AutoMergeToggle projectPath={projectPath} />
                )}
              </div>
            ) : (
              <h2 className="mb-3 px-3 text-xs font-semibold">
                {section.title}{" "}
                <span className="ml-1 font-normal tabular-nums text-muted-foreground">
                  {section.items.length}
                </span>
              </h2>
            )}
            {section.open && (
              <ul
                aria-label={`${section.title} to-dos`}
                className={cn("space-y-2", section.toggle && "mt-2")}
              >
                {section.items.map((item) => (
                  <ProjectTodoItem key={item.id} item={item} store={store} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </AnimatedList>
      {sections.length === 0 && (
        <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
          {searching ? "No matching to-dos." : "No to-dos."}
        </p>
      )}
    </div>
  );
});
