import { type DragEvent, type ReactNode } from "react";

export interface SortableItemDragHandleProps {
  draggable: true;
  onDragStart(event: DragEvent): void;
  onDragEnd(): void;
}

export interface SortableItemProps {
  id: string;
  children(dragHandleProps: SortableItemDragHandleProps): ReactNode;
  className?: string;
  onMove(sourceId: string, targetId: string, placement: "before" | "after"): void;
}

const sortableItemDragType = "application/x-cake-item";
let activeDrag:
  | { sourceId: string; lastTargetId?: string; lastPlacement?: "before" | "after" }
  | undefined;

/** Shared native drag-and-drop wrapper for persistently ordered navigation items. */
export function SortableItem({ id, children, className, onMove }: SortableItemProps) {
  const readSource = (event: DragEvent) =>
    activeDrag?.sourceId ?? event.dataTransfer.getData(sortableItemDragType);
  const moveAtPointer = (event: DragEvent, sourceId: string) => {
    if (sourceId === id) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const placement = event.clientY < bounds.top + bounds.height / 2 ? "before" : "after";
    if (activeDrag?.lastTargetId === id && activeDrag.lastPlacement === placement) return;
    if (activeDrag) {
      activeDrag.lastTargetId = id;
      activeDrag.lastPlacement = placement;
    }
    onMove(sourceId, id, placement);
  };

  return (
    <div
      className={className}
      onDragOver={(event) => {
        // Browsers protect drag payload values until drop, so retain the source from dragstart.
        if (!Array.from(event.dataTransfer.types).includes(sortableItemDragType)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const sourceId = readSource(event);
        if (sourceId) moveAtPointer(event, sourceId);
      }}
      onDrop={(event) => {
        const sourceId = readSource(event);
        if (!sourceId || sourceId === id) return;
        event.preventDefault();
        moveAtPointer(event, sourceId);
        activeDrag = undefined;
      }}
    >
      {children({
        draggable: true,
        onDragStart: (event) => {
          activeDrag = { sourceId: id };
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData(sortableItemDragType, id);
        },
        onDragEnd: () => {
          activeDrag = undefined;
        },
      })}
    </div>
  );
}
