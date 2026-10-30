import { observer } from "r-state-tree/react";
import { useEffect, useRef } from "react";
import { projectTodoAssociationKey } from "../../contracts/projects/project-todos";
import { NavItem } from "@/components/ui/nav-item";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { formatSnoozeDeadline, snoozeTimeZone } from "../lib/project-todo-snooze";
import { ProjectTodoWorkLink } from "./project-todo-work-link";
import { IconButton } from "@/components/ui/icon-button";
import { CircleIcon, CheckIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

export const ProjectTodoItem = observer(function ProjectTodoItem({
  item,
  store,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
}) {
  const selected = store.selectedItem?.id === item.id;
  const inspected = store.visible && store.inspectedItemId === item.id;
  const row = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (inspected) row.current?.scrollIntoView?.({ block: "nearest" });
  }, [inspected]);
  const description = item.description !== item.title ? item.description : "";
  const menuItems: ContextMenuItem[] =
    item.state === "open"
      ? [
          {
            label: item.snoozedUntil ? "Change snooze" : "Snooze",
            disabled: store.busy,
            items: [
              ...[
                ["15 minutes", 15],
                ["1 hour", 60],
                ["4 hours", 240],
                ["1 day", 1440],
                ["1 week", 10080],
              ].map(([label, minutes]) => ({
                label: String(label),
                onSelect: () =>
                  void store.snooze(
                    item,
                    new Date(Date.now() + Number(minutes) * 60_000).toISOString(),
                  ),
              })),
              { label: "Custom…", onSelect: () => store.editSnooze(item) },
            ],
          },
          ...(item.snoozedUntil
            ? [
                {
                  label: "Unsnooze",
                  disabled: store.busy,
                  onSelect: () => void store.unsnooze(item),
                },
              ]
            : []),
        ]
      : [];
  return (
    <li ref={row} data-todo-id={item.id} data-animated-list-key={item.id}>
      <ContextMenu label={`Actions for ${item.title}`} items={menuItems}>
        <NavItem
          wholeRowAction
          selectableText
          associated={selected || inspected}
          aria-busy={store.busy}
          actionProps={{
            "aria-pressed": selected,
            "aria-label": item.title,
            "aria-disabled": store.busy || item.state === "done" || Boolean(item.snoozedUntil),
          }}
          onClick={() => void store.select(item)}
          className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2.5 gap-y-0 px-3 py-2.5 text-sm leading-snug [&>button]:col-start-2 [&>button]:row-start-1 [&>button]:items-start [&>[data-slot=nav-trailing]]:col-start-1 [&>[data-slot=nav-trailing]]:row-start-1 [&_a>svg]:hidden"
          label={
            <span
              className={cn(
                "font-medium leading-snug",
                item.state === "done" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {item.title}
            </span>
          }
          trailing={
            <IconButton
              className="-ml-0.5 size-5"
              disabled={store.busy}
              tooltip={`${item.state === "done" ? "Reopen" : "Mark done"}: ${item.title}`}
              onClick={() => void store.setDone(item)}
            >
              {item.state === "done" ? <CheckIcon /> : <CircleIcon />}
            </IconButton>
          }
        >
          {description && (
            <p className="col-start-2 mt-1 w-full whitespace-pre-wrap break-words text-xs font-normal leading-snug text-muted-foreground">
              {description}
            </p>
          )}
          {item.snoozedUntil && item.state === "open" && (
            <p className="col-start-2 mt-1 text-xs tabular-nums text-muted-foreground">
              Snoozed until{" "}
              <time dateTime={item.snoozedUntil} title={snoozeTimeZone()}>
                {formatSnoozeDeadline(item.snoozedUntil)}
              </time>
            </p>
          )}
          {item.associations.length > 0 && (
            <ul
              aria-label={`Work for ${item.title}`}
              className="col-start-2 mt-2 flex w-full flex-wrap items-center gap-1.5"
            >
              {item.associations.map((association) => (
                <li
                  key={projectTodoAssociationKey(association)}
                  className="flex max-w-full min-w-0 items-center"
                >
                  <ProjectTodoWorkLink association={association} />
                </li>
              ))}
            </ul>
          )}
        </NavItem>
      </ContextMenu>
    </li>
  );
});
