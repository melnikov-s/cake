import { observer } from "r-state-tree/react";
import { AnimatedList } from "@/components/ui/animated-list";
import { Callout } from "@/components/ui/callout";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { cn } from "@/lib/utils";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { ProjectTodoItem } from "./project-todo-item";

export const ProjectTodosPanel = observer(function ProjectTodosPanel({
  store,
}: {
  store: ProjectTodosStore;
}) {
  const attentionItems = store.filteredAttentionItems;
  const searching = Boolean(store.query.trim());
  const sections = [
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
  ];
  return (
    <div className="h-full overflow-y-auto px-3 pb-4 pt-4">
      {store.error && (
        <Callout variant="error" role="alert">
          {store.error}
        </Callout>
      )}
      {attentionItems.length > 0 && (
        <section aria-label="Needs attention">
          <h2 className="mb-3 px-3 text-xs font-semibold">
            Needs attention{" "}
            <span className="ml-1 font-normal tabular-nums text-muted-foreground">
              {attentionItems.length}
            </span>
          </h2>
          <AnimatedList as="ul" aria-label="Needs attention to-dos" className="space-y-2">
            {attentionItems.map((item) => (
              <ProjectTodoItem key={item.id} item={item} store={store} />
            ))}
          </AnimatedList>
        </section>
      )}
      {sections.map((section, index) => (
        <section
          key={section.title}
          aria-label={section.title}
          className={cn(
            "px-1",
            (attentionItems.length > 0 || index > 0) && "mt-4 border-t border-border pt-2",
          )}
        >
          <DisclosureTrigger
            title={`${section.title} (${section.items.length})`}
            open={section.open}
            onClick={section.toggle}
          />
          {section.open &&
            (section.items.length ? (
              <AnimatedList
                as="ul"
                aria-label={`${section.title} to-dos`}
                className="mt-2 space-y-2"
              >
                {section.items.map((item) => (
                  <ProjectTodoItem key={item.id} item={item} store={store} />
                ))}
              </AnimatedList>
            ) : (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                {searching ? "No matching to-dos." : `No ${section.title.toLowerCase()} to-dos.`}
              </p>
            ))}
        </section>
      ))}
    </div>
  );
});
