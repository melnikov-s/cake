const overlays = new Map<HTMLElement, () => void>();

/** Shared popup and dialog primitives retain Escape priority above fullscreen viewers. */
export function registerFullscreenEscapeOverlay(element: HTMLElement, dismiss: () => void) {
  overlays.set(element, dismiss);
  return () => {
    overlays.delete(element);
  };
}

export function fullscreenEscapeOverlay(document: Document) {
  let top: { element: HTMLElement; dismiss: () => void; zIndex: number } | undefined;
  for (const [element, dismiss] of overlays) {
    if (!element.isConnected || element.ownerDocument !== document) continue;
    const zIndex = Number.parseInt(getComputedStyle(element).zIndex, 10) || 0;
    if (
      !top ||
      zIndex > top.zIndex ||
      (zIndex === top.zIndex &&
        top.element.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)
    )
      top = { element, dismiss, zIndex };
  }
  return top;
}

export const fullscreenFrameEscapeEvent = "cake-fullscreen-frame-escape";
