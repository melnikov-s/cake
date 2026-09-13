import { type DragEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SortableItemProps {
  id: string;
  children: ReactNode;
  className?: string;
  onMove(sourceId: string, targetId: string, placement: "before" | "after"): void;
}

/** Shared native drag-and-drop wrapper for persistently ordered navigation items. */
export function SortableItem({ id, children, className, onMove }: SortableItemProps) {
  const readSource = (event: DragEvent) => event.dataTransfer.getData("application/x-cake-item");
  return (
    <div
      className={cn("cursor-grab active:cursor-grabbing", className)}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-cake-item", id);
      }}
      onDragOver={(event) => {
        if (!readSource(event)) return;
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
      {children}
    </div>
  );
}
