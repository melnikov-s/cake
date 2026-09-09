import type { DragEvent } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectWorkflowColor } from "../../domain/application-data";
import { kanbanColumnDragType, kanbanSessionDragType } from "../lib/kanban-drag";
import { cn } from "../lib/utils";
import type { KanbanColumnId, KanbanStore } from "../stores/KanbanStore";
import { KanbanColumnMenu } from "./kanban-column-menu";
import { KanbanSessionCard } from "./kanban-session-card";
import { Badge } from "./ui/badge";
import { GripIcon } from "./ui/icons";
import { IconButton } from "./ui/icon-button";
import { StatusSwatch } from "./ui/status-swatch";

export type KanbanDragItem =
  | { kind: "session"; sessionId: string }
  | { kind: "column"; columnId: string };

const hasCakeDragData = (event: DragEvent<HTMLElement>) =>
  event.dataTransfer.types.includes(kanbanSessionDragType) ||
  event.dataTransfer.types.includes(kanbanColumnDragType);

const columnTint = {
  rose: "border-workflow-rose/35 bg-workflow-rose/10",
  peach: "border-workflow-peach/35 bg-workflow-peach/10",
  amber: "border-workflow-amber/35 bg-workflow-amber/10",
  lime: "border-workflow-lime/35 bg-workflow-lime/10",
  mint: "border-workflow-mint/35 bg-workflow-mint/10",
  sky: "border-workflow-sky/35 bg-workflow-sky/10",
  blue: "border-workflow-blue/35 bg-workflow-blue/10",
  violet: "border-workflow-violet/35 bg-workflow-violet/10",
} satisfies Record<ProjectWorkflowColor, string>;

export interface KanbanColumnProps {
  store: KanbanStore;
  id: KanbanColumnId;
  title: string;
  color?: ProjectWorkflowColor;
  customIndex?: number;
  dragItem?: KanbanDragItem;
  dropActive?: boolean;
  onDragItemChange(item: KanbanDragItem | undefined): void;
  onDragTargetChange(columnId: KanbanColumnId | undefined): void;
}

export const KanbanColumn = observer(function KanbanColumn({
  store,
  id,
  title,
  color,
  customIndex,
  dragItem,
  dropActive,
  onDragItemChange,
  onDragTargetChange,
}: KanbanColumnProps) {
  const sessions = store.sessionsInColumn(id);
  const custom = color !== undefined && customIndex !== undefined;
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sessionId = event.dataTransfer.getData(kanbanSessionDragType);
    const columnId = event.dataTransfer.getData(kanbanColumnDragType);
    if (sessionId) void store.moveSession(sessionId, id);
    else if (columnId && custom) void store.moveColumn(columnId, customIndex);
    onDragTargetChange(undefined);
    onDragItemChange(undefined);
  };
  return (
    <section
      data-column-id={id}
      className={cn(
        "flex h-full w-[min(20rem,82vw)] shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-muted/24",
        color && columnTint[color],
        dragItem?.kind === "column" && dragItem.columnId === id && "opacity-45",
        dropActive && "ring-2 ring-accent ring-offset-2 ring-offset-background",
      )}
      onDragEnter={(event) => {
        if (hasCakeDragData(event)) onDragTargetChange(id);
      }}
      onDragOver={(event) => {
        if (hasCakeDragData(event)) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={onDrop}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 px-3">
        {custom && (
          <IconButton
            draggable
            className="size-6 cursor-grab text-muted-foreground active:cursor-grabbing"
            tooltip={`Reorder ${title}`}
            ariaLabel={`Drag to reorder ${title}`}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(kanbanColumnDragType, id);
              onDragItemChange({ kind: "column", columnId: id });
            }}
            onDragEnd={() => {
              onDragTargetChange(undefined);
              onDragItemChange(undefined);
            }}
          >
            <GripIcon />
          </IconButton>
        )}
        {color && <StatusSwatch color={color} />}
        <strong className="min-w-0 flex-1 truncate text-xs font-semibold">{title}</strong>
        <Badge variant="outline" size="xs">
          {sessions.length}
        </Badge>
        {custom && (
          <KanbanColumnMenu
            name={title}
            color={color}
            busy={store.isColumnPending(id)}
            onUpdate={(input) => store.updateColumn(id, input)}
            onDelete={() => store.deleteColumn(id)}
          />
        )}
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2.5">
        {sessions.map((session) => (
          <KanbanSessionCard
            key={session.sessionId}
            session={session}
            managedWorktree={store.managedWorktree(session.workingDirectory)}
            model={store.modelForSession(session.sessionId)}
            description={store.detailsForSession(session.sessionId)?.description}
            status={store.statusForSession(session.sessionId)}
            busy={store.isSessionPending(session.sessionId)}
            onOpen={() => void store.openSession(session.sessionId)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(kanbanSessionDragType, session.sessionId);
              onDragItemChange({ kind: "session", sessionId: session.sessionId });
            }}
            onDragEnd={() => {
              onDragTargetChange(undefined);
              onDragItemChange(undefined);
            }}
          />
        ))}
        {sessions.length === 0 && (
          <p className="px-2 py-5 text-center text-[11px] text-muted-foreground">
            Drop sessions here
          </p>
        )}
      </div>
    </section>
  );
});
