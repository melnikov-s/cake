import { observer } from "r-state-tree/react";
import {
  projectTodoAssociationKey,
  projectTodoCategory,
} from "../../contracts/projects/project-todos";
import { NavItem } from "@/components/ui/nav-item";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { formatSnoozeDeadline, snoozeTimeZone } from "../lib/project-todo-snooze";
import { ProjectTodoWorkLink } from "./project-todo-work-link";
import { ProjectTodoSnoozePicker } from "./project-todo-snooze-picker";
import { ProjectTodoAttentionEditor } from "./project-todo-attention-editor";
import { IconButton } from "@/components/ui/icon-button";
import { CircleIcon, CheckIcon, PaperclipIcon, CloseIcon } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

const hoverActionClassName =
  "opacity-0 disabled:opacity-0 group-hover/nav-item:opacity-100 group-hover/nav-item:disabled:opacity-30 group-has-[:focus-visible]/nav-item:opacity-100 group-has-[:focus-visible]/nav-item:disabled:opacity-30";

export const ProjectTodoItem = observer(function ProjectTodoItem({
  item,
  store,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
}) {
  const selected = store.isFocused(item.id);
  const inspected = store.visible && store.inspectedItemId === item.id;
  const attention = projectTodoCategory(item) === "attention";
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
              {
                label: "Custom",
                content: (close) => (
                  <ProjectTodoSnoozePicker item={item} store={store} onClose={close} />
                ),
              },
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
          ...(item.attentionReason && !item.needsAttention
            ? [
                {
                  label: "Restore needs attention",
                  disabled: store.busy,
                  onSelect: () => void store.restoreAttention(item),
                },
              ]
            : [
                {
                  label: item.needsAttention ? "Edit attention reason…" : "Mark needs attention…",
                  disabled: store.busy,
                  content: (close: () => void) => (
                    <ProjectTodoAttentionEditor item={item} store={store} onClose={close} />
                  ),
                },
              ]),
        ]
      : [];
  return (
    <li data-todo-id={item.id} data-animated-list-key={item.id}>
      <ContextMenu label={`Actions for ${item.title}`} items={menuItems}>
        <NavItem
          wholeRowAction
          selectableText
          associated={selected || inspected}
          title={`Focus to-do: ${item.title}`}
          aria-busy={store.busy}
          actionProps={{
            "aria-pressed": selected,
            "aria-label": item.title,
            "aria-disabled": false,
          }}
          onClick={() => store.focus(item)}
          className={cn(
            "grid items-start gap-x-2.5 gap-y-0 px-3 py-2.5 text-sm leading-5 [&>[data-slot=nav-action]]:col-start-2 [&>[data-slot=nav-action]]:row-start-1 [&>[data-slot=nav-action]>button:first-child]:items-start [@media(pointer:coarse)]:[&>[data-slot=nav-action]>button:first-child]:pt-3 [&>[data-slot=nav-trailing]]:col-start-1 [&>[data-slot=nav-trailing]]:row-start-1 [&_a>svg]:hidden",
            "grid-cols-[auto_minmax(0,1fr)_auto]",
          )}
          label={
            <span
              className={cn(
                "font-medium leading-5",
                item.state === "done" ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {attention ? item.attentionReason : item.title}
            </span>
          }
          labelAction={
            <IconButton
              className={cn("-my-1 size-7 [&>svg]:size-[9px]", hoverActionClassName)}
              tooltip={`Attach to-do as context: ${item.title}`}
              onClick={(event) => {
                event.stopPropagation();
                store.reply(item);
              }}
            >
              <PaperclipIcon />
            </IconButton>
          }
          trailing={
            <div className="flex items-start gap-2.5">
              <IconButton
                className="-ml-0.5 size-5"
                disabled={store.busy}
                tooltip={`${item.state === "done" ? "Reopen" : "Mark done"}: ${item.title}`}
                onClick={() => void store.setDone(item)}
              >
                {item.state === "done" ? <CheckIcon /> : <CircleIcon />}
              </IconButton>
            </div>
          }
        >
          {(selected || attention) && (
            <IconButton
              className={cn("col-start-3 row-start-1 size-5", hoverActionClassName)}
              tooltip={`${selected ? "Unfocus to-do" : "Dismiss attention"}: ${item.title}`}
              disabled={!selected && store.busy}
              onClick={(event) => {
                event.stopPropagation();
                if (selected) store.unfocus(item);
                else void store.dismissAttention(item);
              }}
            >
              <CloseIcon />
            </IconButton>
          )}
          {attention && (
            <p className="col-span-full mt-1 min-w-0 break-words text-xs text-muted-foreground">
              {item.title}
            </p>
          )}
          {!attention && description && (
            <p className="col-span-full mt-1 w-full whitespace-pre-wrap break-words text-xs font-normal leading-snug text-muted-foreground">
              {description}
            </p>
          )}
          {item.snoozedUntil && item.state === "open" && (
            <p className="col-span-full mt-1 text-xs tabular-nums text-muted-foreground">
              Snoozed until{" "}
              <time dateTime={item.snoozedUntil} title={snoozeTimeZone()}>
                {formatSnoozeDeadline(item.snoozedUntil)}
              </time>
            </p>
          )}
          {item.associations.length > 0 && (
            <ul
              aria-label={`Work for ${item.title}`}
              className="col-span-full mt-2 flex w-full flex-wrap items-center gap-1.5"
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
