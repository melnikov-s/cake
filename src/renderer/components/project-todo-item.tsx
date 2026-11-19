import { Fragment, useId, type ReactNode } from "react";
import { observer } from "r-state-tree/react";
import {
  projectTodoAssociationKey,
  projectTodoAttentionDetail,
  projectTodoCategory,
} from "../../contracts/projects/project-todos";
import { NavItem } from "@/components/ui/nav-item";
import { ContextMenu, type ContextMenuItem } from "@/components/ui/context-menu";
import { formatSnoozeDeadline, snoozeTimeZone } from "../lib/project-todo-snooze";
import { ProjectTodoWorkLink } from "./project-todo-work-link";
import { ProjectTodoSnoozePicker } from "./project-todo-snooze-picker";
import { ProjectTodoAttentionEditor } from "./project-todo-attention-editor";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { ChatIcon, PaperclipIcon, CloseIcon, ExpandIcon } from "@/components/ui/icons";
import { projectTodoAssociationDestination } from "../lib/project-todo-association";
import { ProjectTodoStateAction } from "./project-todo-state-action";
import { ProjectTodoLabelPicker } from "./project-todo-label-picker";
import { ProjectTodoStatusIndicator } from "./project-todo-status-indicator";
import { cn } from "@/lib/utils";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import type { ProjectTodosStore } from "../stores/ProjectTodosStore";

const hoverActionClassName =
  "opacity-0 disabled:opacity-0 group-hover/nav-item:opacity-100 group-hover/nav-item:disabled:opacity-30 group-has-[:focus-visible]/nav-item:opacity-100 group-has-[:focus-visible]/nav-item:disabled:opacity-30 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:disabled:opacity-30";

export const ProjectTodoItem = observer(function ProjectTodoItem({
  item,
  store,
  section,
  allowsCakeMerge = true,
  position,
  count,
}: {
  item: ProjectTodo;
  store: ProjectTodosStore;
  section?: string;
  allowsCakeMerge?: boolean;
  position?: number;
  count?: number;
}) {
  const descriptionId = useId();
  const detailsId = `${descriptionId}-details`;
  const selected = store.isFocused(item.id);
  const inspected = store.visible && store.inspectedItemId === item.id;
  const attention = projectTodoCategory(item) === "attention";
  const attentionDetail = attention ? projectTodoAttentionDetail(item) : undefined;
  const description =
    item.description.trim() && item.description !== item.title ? item.description : "";
  const disclosure = store.itemDisclosure(item.id);
  const expanded = disclosure?.details ?? false;
  const linksExpanded = disclosure?.links ?? false;
  const summary = store.itemActivitySummary(item);
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
  const totalLinks = workLinks.length + otherResponses.length;
  const linkKindIcons: Array<ReturnType<typeof projectTodoAssociationDestination>["Icon"]> = [];
  for (const association of workLinks) {
    const { Icon } = projectTodoAssociationDestination(association);
    if (!linkKindIcons.includes(Icon)) linkKindIcons.push(Icon);
  }
  if (otherResponses.length > 0 && !linkKindIcons.includes(ChatIcon)) linkKindIcons.push(ChatIcon);
  const shownLinkIcons = linkKindIcons.slice(0, 4);
  const extraLinkCount = totalLinks - shownLinkIcons.length;
  const statusParts: ReactNode[] = [];
  if (item.state === "open" && !item.snoozedUntil) {
    if (summary.mergeFailed) {
      statusParts.push(
        <span key="merge-failed" className="font-medium text-destructive">
          Merge failed
        </span>,
      );
    } else if (summary.readyToMerge) {
      statusParts.push(
        <span key="ready" className="font-medium text-success">
          {allowsCakeMerge ? "Ready to merge" : "Ready"}
        </span>,
      );
    } else if (summary.running > 0) {
      statusParts.push(
        <span key="running" className="font-medium tabular-nums text-accent">
          {summary.running} running
        </span>,
      );
    } else if (summary.error > 0) {
      statusParts.push(
        <span key="error" className="font-medium tabular-nums text-destructive">
          {summary.error} failed
        </span>,
      );
    } else if (summary.blocked > 0 || summary.waiting > 0) {
      statusParts.push(
        <span key="waiting" className="font-medium text-attention">
          Waiting
        </span>,
      );
    }
  }
  if (summary.totalSessions > 1 && summary.resolved > 0) {
    statusParts.push(
      <span key="resolved" className="tabular-nums text-muted-foreground">
        {summary.resolved}/{summary.totalSessions} resolved
      </span>,
    );
  }
  if (item.snoozedUntil && item.state === "open") {
    statusParts.push(
      <span key="snoozed" className="tabular-nums text-muted-foreground">
        Snoozed until{" "}
        <time dateTime={item.snoozedUntil} title={snoozeTimeZone()}>
          {formatSnoozeDeadline(item.snoozedUntil)}
        </time>
      </span>,
    );
  }
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
  const rowContent = (
    <NavItem
      wholeRowAction
      selectableText
      associated={selected || inspected}
      viewFocused={selected}
      aria-busy={store.busy}
      actionProps={{
        "data-slot": "todo-disclosure",
        "aria-expanded": expanded,
        "aria-controls": detailsId,
        "aria-label": item.title,
        "aria-describedby": description ? descriptionId : undefined,
        "aria-disabled": false,
      }}
      onClick={() => store.toggleItemExpanded(item.id)}
      className={cn(
        "grid items-start gap-x-2.5 gap-y-0 px-3 py-2 text-sm leading-5 [&>button:first-child]:col-start-2 [&>button:first-child]:row-start-1 [&>button:first-child]:items-start [@media(pointer:coarse)]:[&>button:first-child]:pt-3 [&>[data-slot=nav-trailing]]:col-start-1 [&>[data-slot=nav-trailing]]:row-start-1 [&_a>svg]:hidden",
        "grid-cols-[auto_minmax(0,1fr)_auto]",
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
        <ProjectTodoStatusIndicator
          item={item}
          summary={summary}
          allowsCakeMerge={allowsCakeMerge}
          className="mt-0.5"
        />
      }
    >
      <div
        data-slot="todo-actions"
        className={cn(
          "col-start-3 row-start-1 -mt-0.5 flex items-center gap-0.5 rounded-md border border-border/75 bg-card/95 p-0.5 shadow-xs backdrop-blur-sm transition-opacity",
          hoverActionClassName,
        )}
      >
        <IconButton
          data-slot="todo-focus"
          iconSize="inline"
          className={cn("size-6 [@media(pointer:coarse)]:size-11", hoverActionClassName)}
          tooltip={`Focus to-do: ${item.title}`}
          wrapTooltip
          aria-pressed={selected}
          onClick={() => store.toggleFocus(item)}
        >
          <ExpandIcon />
        </IconButton>
        <ProjectTodoStateAction
          item={item}
          title={item.title}
          done={item.state === "done"}
          store={store}
          className={cn("size-6 [@media(pointer:coarse)]:size-11", hoverActionClassName)}
        />
        <IconButton
          iconSize="inline"
          className={cn("size-6 [@media(pointer:coarse)]:size-11", hoverActionClassName)}
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
            className={cn("size-6 [@media(pointer:coarse)]:size-11", hoverActionClassName)}
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
      <div id={detailsId} className="col-start-2 col-span-2 min-w-0">
        {attentionDetail && (
          <p className="mt-1.5 min-w-0 break-words rounded-md bg-attention/15 px-2 py-1 text-xs leading-4 text-foreground">
            {attentionDetail}
          </p>
        )}
        {description && (
          <p
            id={descriptionId}
            className={cn(
              "mt-1 min-w-0 break-words text-xs leading-4 text-muted-foreground",
              expanded ? "whitespace-pre-wrap" : "line-clamp-2",
            )}
          >
            {description}
          </p>
        )}
        {expanded && item.status.trim() && (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-4 text-muted-foreground">
            <span className="font-medium">Status:</span> {item.status}
          </p>
        )}
        <div className="mt-1.5 flex items-center justify-between gap-2 text-xs">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
            <ProjectTodoLabelPicker
              item={item}
              store={store}
              showName
              className="max-w-36"
              unlabelledClassName={hoverActionClassName}
            />
            {statusParts.length > 0 && (
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                {statusParts.map((part, index) => (
                  <Fragment key={index}>
                    {index > 0 && (
                      <span aria-hidden="true" className="text-muted-foreground/70">
                        ·
                      </span>
                    )}
                    {part}
                  </Fragment>
                ))}
              </span>
            )}
          </div>
          {totalLinks > 0 && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={linksExpanded}
              aria-label={`${linksExpanded ? "Hide" : "Show"} ${totalLinks} ${totalLinks === 1 ? "link" : "links"} for ${item.title}`}
              title={`${totalLinks} linked ${totalLinks === 1 ? "item" : "items"}`}
              className={cn(
                "h-6 shrink-0 gap-1.5 rounded-full px-1 text-xs font-normal tabular-nums",
                linksExpanded && "bg-accent/15 text-accent hover:bg-accent/20 hover:text-accent",
              )}
              onClick={(event) => {
                event.stopPropagation();
                store.toggleLinksExpanded(item.id);
              }}
            >
              <span className="flex items-center -space-x-1.5" data-slot="todo-link-tokens">
                {shownLinkIcons.map((Icon, index) => (
                  <span
                    key={index}
                    className={cn(
                      "inline-flex size-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-2xs [&>svg]:size-2.5",
                      linksExpanded && "border-accent/40 text-accent",
                    )}
                  >
                    <Icon />
                  </span>
                ))}
              </span>
              {extraLinkCount > 0 && (
                <span
                  className={cn(
                    "pr-1 text-xs tabular-nums text-muted-foreground",
                    linksExpanded && "text-accent",
                  )}
                >
                  +{extraLinkCount}
                </span>
              )}
            </Button>
          )}
        </div>
        {linksExpanded && totalLinks > 0 && (
          <div className="mt-2 border-t border-border/65 pt-2">
            {workLinks.length > 0 && (
              <ul aria-label={`Work for ${item.title}`} className="flex w-full flex-col gap-0.5">
                {workLinks.map((association) => (
                  <li key={projectTodoAssociationKey(association)} className="flex min-w-0">
                    <ProjectTodoWorkLink association={association} />
                  </li>
                ))}
              </ul>
            )}
            {otherResponses.length > 0 && (
              <details className="relative w-fit px-2 py-0.5 text-xs leading-4 text-muted-foreground">
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
          </div>
        )}
      </div>
    </NavItem>
  );
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
        {rowContent}
      </ContextMenu>
    </li>
  );
});
