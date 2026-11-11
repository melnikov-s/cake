type Bounds = { top: number; bottom: number; left: number; right: number };

export type MessageActionAlign = "start" | "end";

export type MessageActionPlacement =
  | { kind: "footer" | "hidden" }
  | { kind: "above" | "side"; top: number; left: number };

/**
 * The part of the chat where floating controls can be seen: the transcript's
 * client box, clipped to the window and ended above the composer that overlays
 * the bottom of the transcript. An in-flow composer sits below the transcript
 * and so changes nothing.
 */
export function messageActionViewport({
  scroller,
  window,
  composerTop,
}: {
  scroller: {
    top: number;
    left: number;
    clientTop: number;
    clientLeft: number;
    clientWidth: number;
    clientHeight: number;
  };
  window: { width: number; height: number };
  composerTop?: number;
}): Bounds {
  const top = scroller.top + scroller.clientTop;
  const left = scroller.left + scroller.clientLeft;
  return {
    top: Math.max(0, top),
    bottom: Math.min(window.height, top + scroller.clientHeight, composerTop ?? Infinity),
    left: Math.max(0, left),
    right: Math.min(window.width, left + scroller.clientWidth),
  };
}

/** All floating controls stay outside the message and inside the chat viewport. */
export function messageActionPlacement({
  message,
  viewport,
  row,
  column,
  align = "start",
  gap = 8,
}: {
  message: Bounds;
  viewport: Bounds;
  row: { width: number; height: number };
  column: { width: number; height: number };
  /** The message edge the row follows, matching where its footer sits. */
  align?: MessageActionAlign;
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
    const left =
      align === "end"
        ? Math.min(viewport.right, message.right) - row.width
        : Math.max(viewport.left, message.left);
    return top >= viewport.top && left >= viewport.left && left + row.width <= viewport.right
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
