import { useId } from "react";
import { observer } from "r-state-tree/react";
import {
  projectTodoAssociationKey,
  projectTodoAttentionDetail,
  projectTodoCategory,
} from "../../contracts/projects/project-todos";
import { NavItem } from "@/components/ui/nav-item";
import { HoverCard } from "@/components/ui/hover-card";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { formatSnoozeDeadline, snoozeTimeZone } from "../lib/project-todo-snooze";
import { ProjectTodoWorkLink } from "./project-todo-work-link";
import { ProjectTodoSnoozePicker } from "./project-todo-snooze-picker";
import { ProjectTodoAttentionEditor } from "./project-todo-attention-editor";
import { IconButton } from "@/components/ui/icon-button";
import { PaperclipIcon, CloseIcon } from "@/components/ui/icons";
import { ProjectTodoStateAction } from "./project-todo-state-action";
import { ProjectTodoLabelPicker } from "./project-todo-label-picker";
import { cn } from "@/lib/utils";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

const hoverActionClassName =
  "opacity-0 disabled:opacity-0 group-hover/nav-item:opacity-100 group-hover/nav-item:disabled:opacity-30 group-has-[:focus-visible]/nav-item:opacity-100 group-has-[:focus-visible]/nav-item:disabled:opacity-30 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:disabled:opacity-30";

export const ProjectTodoItem = observer(function ProjectTodoItem({
  item,
  store,
  section,
  position,
  count,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
  section?: string;
  position?: number;
  count?: number;
}) {
  const descriptionId = useId();
  const selected = store.isFocused(item.id);
  const inspected = store.visible && store.inspectedItemId === item.id;
  const attention = projectTodoCategory(item) === "attention";
  const attentionDetail = attention ? projectTodoAttentionDetail(item) : undefined;
  const description = item.description !== item.title ? item.description : "";
  const sessionIds = new Set<string>();
  const associations = item.associations.filter((association) => {
    if (association.kind !== "session") return true;
    if (sessionIds.has(association.sessionId)) return false;
    sessionIds.add(association.sessionId);
    return true;
  });
  const representative = item.responses?.representative;
  const existingResponse = associations.find(
    (link) => link.kind === "source" && link.ref === representative,
  );
  const otherResponses =
    item.responses?.refs.filter(
      (ref) =>
        ref !== representative &&
        !associations.some((link) => link.kind === "source" && link.ref === ref),
    ) ?? [];
  const workLinks = representative
    ? [
        existingResponse ?? {
          kind: "source" as const,
          ref: representative,
          title: "Agent response",
        },
        ...associations.filter((link) => link !== existingResponse),
      ]
    : associations;
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
    <li
      data-todo-id={item.id}
      data-animated-list-key={item.id}
      data-todo-section={section}
      aria-label={section ? `${section} to-do` : undefined}
      aria-posinset={position}
      aria-setsize={count}
    >
      <ContextMenu label={`Actions for ${item.title}`} items={menuItems}>
        <HoverCard description={description} descriptionId={descriptionId}>
          <NavItem
            wholeRowAction
            selectableText
            associated={selected || inspected}
            viewFocused={selected}
            aria-busy={store.busy}
            actionProps={{
              "aria-pressed": selected,
              "aria-label": item.title,
              "aria-describedby": description ? descriptionId : undefined,
              "aria-disabled": false,
            }}
            onClick={() => store.toggleFocus(item)}
            className={cn(
              "grid items-start gap-x-2.5 gap-y-0 px-3 text-sm leading-5 [&>button:first-child]:col-start-2 [&>button:first-child]:row-start-1 [&>button:first-child]:items-start [@media(pointer:coarse)]:[&>button:first-child]:pt-3 [&>[data-slot=nav-trailing]]:col-start-1 [&>[data-slot=nav-trailing]]:row-start-1 [&_a>svg]:hidden",
              "grid-cols-[auto_minmax(0,1fr)_auto] py-2",
              description &&
                !workLinks.length &&
                !attentionDetail &&
                !item.snoozedUntil &&
                "py-1.5",
            )}
            label={
              <span
                className={cn(
                  "font-medium leading-5",
                  item.state === "done" ? "text-muted-foreground" : "text-foreground",
                )}
              >
                {item.title}
              </span>
            }
            trailing={
              <ProjectTodoLabelPicker
                item={item}
                store={store}
                className="-my-1 -ml-1 size-7 [@media(pointer:coarse)]:my-0"
              />
            }
          >
            <div
              data-slot="todo-actions"
              className="col-start-3 row-start-1 grid grid-cols-[1.75rem_1.75rem_1.25rem] items-start [@media(pointer:coarse)]:grid-cols-[repeat(3,2.75rem)]"
            >
              <ProjectTodoStateAction
                item={item}
                title={item.title}
                done={item.state === "done"}
                store={store}
                className={cn("-my-1 size-7 [@media(pointer:coarse)]:my-0", hoverActionClassName)}
              />
              <IconButton
                iconSize="inline"
                className={cn("-my-1 size-7 [@media(pointer:coarse)]:my-0", hoverActionClassName)}
                tooltip={`Attach to-do as context: ${item.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  store.reply(item);
                }}
              >
                <PaperclipIcon />
              </IconButton>
              {(selected || attention) && (
                <IconButton
                  iconSize="inline"
                  className={cn("size-5", hoverActionClassName)}
                  tooltip={`${selected ? "Unfocus to-do" : "Dismiss attention"}: ${item.title}`}
                  disabled={!selected && store.busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (selected) store.unfocus(item);
                    else void store.dismissAttention(item);
                  }}
                >
                  <CloseIcon size={12} />
                </IconButton>
              )}
            </div>
            {attentionDetail && (
              <p className="col-span-full mt-1 min-w-0 break-words text-xs text-muted-foreground">
                {attentionDetail}
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
            {workLinks.length > 0 && (
              <ul
                aria-label={`Work for ${item.title}`}
                className="col-span-full mt-1.5 flex w-full flex-col gap-0.5"
              >
                {workLinks.map((association) => (
                  <li key={projectTodoAssociationKey(association)} className="flex min-w-0">
                    <ProjectTodoWorkLink association={association} />
                  </li>
                ))}
              </ul>
            )}
            {otherResponses.length > 0 && (
              <details className="relative col-span-full w-fit px-2 py-0.5 text-xs leading-4 text-muted-foreground">
                <summary className="cursor-pointer hover:underline">
                  Other responses ({otherResponses.length})
                </summary>
                <ul aria-label={`Other responses for ${item.title}`}>
                  {otherResponses.map((ref, index) => (
                    <li key={ref}>
                      <ProjectTodoWorkLink
                        association={{ kind: "source", ref, title: `Response ${index + 1}` }}
                      />
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </NavItem>
        </HoverCard>
      </ContextMenu>
    </li>
  );
});
