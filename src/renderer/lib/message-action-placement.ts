type Bounds = { top: number; bottom: number; left: number; right: number };

export type MessageActionPlacement =
  | { kind: "footer" | "hidden" }
  | { kind: "above" | "side"; top: number; left: number };

/** All floating controls stay outside the message and inside the chat viewport. */
export function messageActionPlacement({
  message,
  viewport,
  row,
  column,
  gap = 8,
}: {
  message: Bounds;
  viewport: Bounds;
  row: { width: number; height: number };
  column: { width: number; height: number };
  gap?: number;
}): MessageActionPlacement {
  if (
    message.bottom <= viewport.top ||
    message.top >= viewport.bottom ||
    message.right <= viewport.left ||
    message.left >= viewport.right
  )
    return { kind: "hidden" };
  if (message.bottom <= viewport.bottom) return { kind: "footer" };
  if (message.top >= viewport.top) {
    const top = message.top - gap - row.height;
    const left = Math.max(viewport.left, message.left);
    return top >= viewport.top && left + row.width <= viewport.right
      ? { kind: "above", top, left }
      : { kind: "hidden" };
  }
  if (column.height > viewport.bottom - viewport.top) return { kind: "hidden" };
  const top = (viewport.top + viewport.bottom - column.height) / 2;
  if (message.right + gap + column.width <= viewport.right)
    return { kind: "side", top, left: message.right + gap };
  if (message.left - gap - column.width >= viewport.left)
    return { kind: "side", top, left: message.left - gap - column.width };
  return { kind: "hidden" };
}
