import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { observer, useStore } from "r-state-tree/react";
import { RootStore } from "../stores/RootStore";
import { Callout } from "@/components/ui/callout";
import { DisclosureTrigger } from "@/components/ui/disclosure-trigger";
import { cn } from "@/lib/utils";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";
import { ProjectTodoItem } from "./project-todo-item";

type Section = {
  key: string;
  title: string;
  items: ProjectTodo[];
  open: boolean;
  toggle?: () => void;
};
type Row =
  | { key: string; kind: "header"; section: Section; first: boolean }
  | { key: string; kind: "todo"; section: Section; item: ProjectTodo };

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
  const list = useRef<LegendListRef>(null);
  const [focusedKey, setFocusedKey] = useState<string>();
  // Scroll promises can settle before React commits the destination. The row ref
  // completes navigation on its actual mount instead of racing the virtualizer.
  const pending = useRef<{ key: string; apply(element: HTMLElement): void } | undefined>(undefined);
  const attachRow = (key: string, element: HTMLElement | null) => {
    const navigation = pending.current;
    if (!element || navigation?.key !== key) return;
    pending.current = undefined;
    navigation.apply(element);
  };
  useEffect(() => {
    void store.reconcile();
  }, [store]);
  const classified = store.classifiedItems;
  const sections: Section[] = [
    { key: "focus", title: "Focus", items: classified.focused, open: true },
    { key: "attention", title: "Needs attention", items: classified.attention, open: true },
    {
      key: "ready",
      title: allowsCakeMerge ? "Ready to Merge" : "Ready",
      items: classified.ready,
      open: store.readyExpanded,
      toggle: () => store.toggleReady(),
    },
    {
      key: "active",
      title: "Active",
      items: classified.active,
      open: store.activeExpanded,
      toggle: () => store.toggleActive(),
    },
    {
      key: "snoozed",
      title: "Snoozed",
      items: classified.snoozed,
      open: store.snoozedExpanded,
      toggle: () => store.toggleSnoozed(),
    },
    {
      key: "done",
      title: "Done",
      items: classified.done,
      open: store.doneExpanded,
      toggle: () => store.toggleDone(),
    },
  ].filter((section) => section.items.length > 0);
  const rows: Row[] = sections.flatMap((section, index) => [
    { key: `section:${section.key}`, kind: "header", section, first: index === 0 },
    ...(section.open
      ? section.items.map((item): Row => ({
          key: item.id,
          kind: "todo",
          section,
          item,
        }))
      : []),
  ]);
  // Navigation must materialize an offscreen destination before restoring focus.
  // Only explicit requests do this; background updates use the list's key/size anchoring.
  const request = store.paneRequest;
  useLayoutEffect(() => {
    if (!request) return;
    const current = list.current;
    if (!current) return;
    let cancelled = false;
    const focusOwner = document.activeElement;
    const navigate = async () => {
      const index = current.getState().indexByKey(request.id);
      if (index === undefined) {
        store.completePaneRequest();
        return;
      }
      pending.current = {
        key: request.id,
        apply: (element) => {
          if (cancelled || store.paneRequest !== request) return;
          if (
            request.focus &&
            (document.activeElement === focusOwner || document.activeElement === document.body)
          )
            element
              .querySelector<HTMLButtonElement>("[aria-pressed]")
              ?.focus({ preventScroll: true });
          store.completePaneRequest();
        },
      };
      if (request.scroll === "top") {
        await current.scrollToOffset({ offset: 0, animated: false });
      } else if (request.scroll === "nearest" || request.focus) {
        await current.scrollIndexIntoView({ index, animated: false });
      }
      if (cancelled || store.paneRequest !== request) return;
      const pane = current.getScrollableNode();
      if (!(pane instanceof HTMLElement)) return;
      const row = Array.from(pane.querySelectorAll<HTMLElement>("[data-todo-virtual-key]")).find(
        (candidate) => candidate.dataset.todoVirtualKey === request.id,
      );
      attachRow(request.id, row ?? null);
    };
    void navigate();
    return () => {
      cancelled = true;
      if (pending.current?.key === request.id) pending.current = undefined;
    };
  }, [request, store]);

  return (
    <LegendList<Row>
      ref={list}
      data-slot="todo-scroll-pane"
      role="list"
      aria-label="To-dos"
      className="h-full overflow-y-auto [overflow-anchor:none]"
      contentContainerClassName="px-3 pb-4 pt-4"
      dataKey={projectPath}
      data={rows}
      keyExtractor={(row) => row.key}
      getItemType={(row) => row.kind}
      recycleItems={false}
      estimatedItemSize={100}
      drawDistance={300}
      maintainVisibleContentPosition={{ data: true, size: true }}
      // Keep the keyboard owner alive while scrolling, without retaining the history.
      alwaysRender={
        focusedKey && rows.some((row) => row.key === focusedKey)
          ? { keys: [focusedKey] }
          : undefined
      }
      onFocusCapture={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        setFocusedKey(
          event.target.closest<HTMLElement>("[data-todo-virtual-key]")?.dataset.todoVirtualKey,
        );
      }}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setFocusedKey(undefined);
      }}
      onKeyDownCapture={(event) => {
        // Plain Tab retains Cake's window-level writing shortcut. Shift+Tab is
        // sequential control navigation, including across virtual boundaries.
        if (
          event.key !== "Tab" ||
          !event.shiftKey ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey
        )
          return;
        if (!(event.target instanceof HTMLElement)) return;
        const owner = event.target.closest<HTMLElement>("[data-todo-virtual-key]");
        if (!owner) return;
        const focusables = (element: HTMLElement) =>
          Array.from(
            element.querySelectorAll<HTMLElement>(
              'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
            ),
          ).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
        const controls = focusables(owner);
        if (event.target !== controls[0]) return;
        let index = rows.findIndex((row) => row.key === owner.dataset.todoVirtualKey) - 1;
        while (index >= 0 && index < rows.length) {
          const row = rows[index]!;
          if (row.kind === "todo" || row.section.toggle) break;
          index -= 1;
        }
        const next = rows[index];
        const current = list.current;
        if (!next || !current) return; // Let Tab leave the pane at either logical end.
        const pane = current.getScrollableNode();
        if (!(pane instanceof HTMLElement)) return;
        const findNext = () =>
          Array.from(pane.querySelectorAll<HTMLElement>("[data-todo-virtual-key]")).find(
            (element) => element.dataset.todoVirtualKey === next.key,
          );
        // The virtualizer may still be settling DOM order after a move. Traverse by
        // logical identity even when the next row is already materialized.
        event.preventDefault();
        pending.current = {
          key: next.key,
          apply: (element) => {
            if (!owner.contains(document.activeElement) && document.activeElement !== document.body)
              return;
            focusables(element).at(-1)?.focus({ preventScroll: true });
          },
        };
        void current.scrollIndexIntoView({ index, animated: false }).then(() => {
          attachRow(next.key, findNext() ?? null);
        });
      }}
      ListHeaderComponent={
        store.error ? (
          <Callout variant="error" role="alert">
            {store.error}
          </Callout>
        ) : null
      }
      ListEmptyComponent={
        <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
          {store.query.trim() ? "No matching to-dos." : "No to-dos."}
        </p>
      }
      renderItem={({ item: row, index }) =>
        row.kind === "header" ? (
          <div
            ref={(element) => attachRow(row.key, element)}
            role="listitem"
            data-todo-virtual-key={row.key}
            aria-posinset={index + 1}
            aria-setsize={rows.length}
          >
            <section
              aria-label={row.section.title}
              data-todo-section-header={row.section.key}
              className={cn(
                row.section.toggle && "px-1",
                !row.first && "mt-4 border-t border-border pt-2",
                "pb-2",
              )}
            >
              {row.section.toggle ? (
                <DisclosureTrigger
                  className="[&_svg]:size-3"
                  title={`${row.section.title} (${row.section.items.length})`}
                  open={row.section.open}
                  onClick={row.section.toggle}
                />
              ) : (
                <h2 className="px-3 text-xs font-semibold">
                  {row.section.title}{" "}
                  <span className="ml-1 font-normal tabular-nums text-muted-foreground">
                    {row.section.items.length}
                  </span>
                </h2>
              )}
            </section>
          </div>
        ) : (
          <div
            ref={(element) => attachRow(row.key, element)}
            role="presentation"
            data-todo-virtual-key={row.key}
            className={cn("pb-2", row.section.toggle && "px-1")}
          >
            <ProjectTodoItem
              item={row.item}
              store={store}
              section={row.section.title}
              position={index + 1}
              count={rows.length}
            />
          </div>
        )
      }
    />
  );
});
