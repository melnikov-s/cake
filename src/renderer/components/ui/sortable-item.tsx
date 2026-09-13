import { type DragEvent, type ReactNode } from "react";

export interface SortableItemDragHandleProps {
  draggable: true;
  onDragStart(event: DragEvent): void;
}

export interface SortableItemProps {
  id: string;
  children(dragHandleProps: SortableItemDragHandleProps): ReactNode;
  className?: string;
  onMove(sourceId: string, targetId: string, placement: "before" | "after"): void;
}

const sortableItemDragType = "application/x-cake-item";

/** Shared native drag-and-drop wrapper for persistently ordered navigation items. */
export function SortableItem({ id, children, className, onMove }: SortableItemProps) {
  const readSource = (event: DragEvent) => event.dataTransfer.getData(sortableItemDragType);
  return (
    <div
      className={className}
      onDragOver={(event) => {
        // Browsers protect drag payload values until drop, so getData() is empty here.
        // The advertised types remain readable and determine whether this is our drag.
        if (!Array.from(event.dataTransfer.types).includes(sortableItemDragType)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        const sourceId = readSource(event);
        if (!sourceId || sourceId === id) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onMove(sourceId, id, event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
      }}
    >
      {children({
        draggable: true,
        onDragStart: (event) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(sortableItemDragType, id);
        },
      })}
    </div>
  );
}
