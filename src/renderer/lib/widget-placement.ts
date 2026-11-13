import type { WidgetSlot } from "../../contracts/widgets/widget-attachment";

export interface PlacementRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface WidgetDropTarget {
  slot: WidgetSlot;
  rect: PlacementRect;
}

/** Empty edges use the same container geometry as occupied slots. */
export function chatDropTargets(rect: PlacementRect): WidgetDropTarget[] {
  const { left, top, width, height } = rect;
  const horizontal = height / 4;
  const vertical = width / 4;
  return [
    { slot: "top", rect: { left, top, width, height: horizontal } },
    { slot: "bottom", rect: { left, top: top + height - horizontal, width, height: horizontal } },
    {
      slot: "left",
      rect: { left, top: top + horizontal, width: vertical, height: height - 2 * horizontal },
    },
    {
      slot: "right",
      rect: {
        left: left + width - vertical,
        top: top + horizontal,
        width: vertical,
        height: height - 2 * horizontal,
      },
    },
  ];
}

export function containsPoint(rect: PlacementRect, x: number, y: number) {
  return (
    x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height
  );
}

/** Insert before the first visible sibling below the pointer, or append. */
export function widgetDropOrder(
  siblings: { id: string; order: number; rect?: PlacementRect }[],
  y: number,
) {
  return siblings.find((entry) => entry.rect && y < entry.rect.top + entry.rect.height / 2)?.order;
}
