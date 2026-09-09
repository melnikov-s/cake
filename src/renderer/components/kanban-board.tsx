import { useState } from "react";
import { observer } from "r-state-tree/react";
import type { ProjectWorkflowColor } from "../../domain/application/application-data";
import type { KanbanColumnId, KanbanStore } from "../stores/KanbanStore";
import { kanbanSessionDragType } from "../lib/kanban-drag";
import { cn } from "../lib/utils";
import { ErrorNotice } from "./error-notice";
import { KanbanColumn, type KanbanDragItem } from "./kanban-column";
import { Button } from "./ui/button";
import { ColorPicker } from "./ui/color-picker";
import { PlusIcon, ResolveIcon } from "./ui/icons";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export const KanbanBoard = observer(function KanbanBoard({ store }: { store: KanbanStore }) {
  const [dragItem, setDragItem] = useState<KanbanDragItem>();
  const [dragTargetColumnId, setDragTargetColumnId] = useState<KanbanColumnId>();
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState<ProjectWorkflowColor>("sky");
  const project = store.project;
  if (!project) {
    return (
      <div className="grid h-full place-items-center p-8">
        <ErrorNotice title="Project unavailable" message="This Project is no longer registered." />
      </div>
    );
  }
  const add = async () => {
    if (!(await store.addColumn(name, color))) return;
    setName("");
    setColor("sky");
    setAddOpen(false);
  };
  return (
    <div data-slot="kanban-board" className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border/65 px-5 py-3">
        <div className="min-w-0">
          <h1 className="truncate font-display text-lg font-semibold tracking-tight">
            {project.name}
          </h1>
          <p className="text-xs text-muted-foreground">Session workflow</p>
        </div>
        <Popover open={addOpen} onOpenChange={setAddOpen}>
          <PopoverTrigger size="sm" className="shrink-0 gap-1.5">
            <PlusIcon /> Add status
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 space-y-3">
            <div className="space-y-1.5">
              <label
                htmlFor="new-kanban-status"
                className="text-[11px] font-medium text-muted-foreground"
              >
                Status name
              </label>
              <Input
                id="new-kanban-status"
                value={name}
                maxLength={40}
                placeholder="In progress"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void add();
                }}
              />
            </div>
            <ColorPicker value={color} onChange={setColor} />
            <div className="flex justify-end">
              <Button size="sm" disabled={!name.trim()} onClick={() => void add()}>
                Create status
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      {store.error && (
        <div className="shrink-0 px-5 pt-4">
          <ErrorNotice title="Kanban operation failed" message={store.error} />
        </div>
      )}
      {dragItem?.kind === "session" && store.canMoveSessionToResolved(dragItem.sessionId) && (
        <div
          data-slot="kanban-resolve-drop-target"
          className={cn(
            "absolute right-6 bottom-6 z-30 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-xs font-semibold text-muted-foreground shadow-lg transition-all",
            dragTargetColumnId === "resolved" &&
              "border-accent bg-accent/15 text-foreground ring-2 ring-accent/35",
          )}
          onDragEnter={() => setDragTargetColumnId("resolved")}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            const sessionId = event.dataTransfer.getData(kanbanSessionDragType);
            if (sessionId) void store.moveSession(sessionId, "resolved");
            setDragTargetColumnId(undefined);
            setDragItem(undefined);
          }}
        >
          <ResolveIcon /> Drop to resolve
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
        <KanbanColumn
          store={store}
          id="draft"
          title="Draft"
          dragItem={dragItem}
          dropActive={dragTargetColumnId === "draft"}
          onDragItemChange={setDragItem}
          onDragTargetChange={setDragTargetColumnId}
        />
        <KanbanColumn
          store={store}
          id="active"
          title="Active"
          dragItem={dragItem}
          dropActive={dragTargetColumnId === "active"}
          onDragItemChange={setDragItem}
          onDragTargetChange={setDragTargetColumnId}
        />
        {store.customColumns.map((column, index) => (
          <KanbanColumn
            key={column.id}
            store={store}
            id={column.id}
            title={column.name}
            color={column.color}
            customIndex={index}
            dragItem={dragItem}
            dropActive={dragTargetColumnId === column.id}
            onDragItemChange={setDragItem}
            onDragTargetChange={setDragTargetColumnId}
          />
        ))}
        <KanbanColumn
          store={store}
          id="resolved"
          title="Resolved"
          dragItem={dragItem}
          dropActive={dragTargetColumnId === "resolved"}
          onDragItemChange={setDragItem}
          onDragTargetChange={setDragTargetColumnId}
        />
      </div>
    </div>
  );
});
