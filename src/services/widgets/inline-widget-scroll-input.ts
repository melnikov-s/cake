/** Forward only gestures that can escape the opaque widget into its transcript. */
function forwardScrollInput(token: string) {
  const send = (direction: number) =>
    parent.postMessage(
      { source: "cake-inline-widget", token, type: "scroll-input", value: direction },
      "*",
    );
  const gesture = (event: Event, direction: number) => {
    if (!event.isTrusted || event.defaultPrevented || !direction) return;
    for (
      let element = event.target instanceof Element ? event.target : null;
      element;
      element = element.parentElement
    ) {
      if (!(element instanceof HTMLElement)) continue;
      const style = getComputedStyle(element);
      if (!["auto", "scroll"].includes(style.overflowY)) continue;
      const canScroll =
        direction < 0
          ? element.scrollTop > 0
          : element.scrollTop + element.clientHeight < element.scrollHeight;
      if (canScroll || ["contain", "none"].includes(style.overscrollBehaviorY)) return;
    }
    send(Math.sign(direction));
  };
  addEventListener("wheel", (event) => gesture(event, event.deltaY), { passive: true });
  addEventListener(
    "pointerdown",
    (event) => {
      if (event.isTrusted) send(0);
    },
    true,
  );
  addEventListener("keydown", (event) => {
    if (
      event.target instanceof Element &&
      event.target.closest('input, textarea, select, [contenteditable="true"]')
    )
      return;
    if (["Home", "ArrowUp", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey))
      gesture(event, -1);
    else if (["End", "ArrowDown", "PageDown", " "].includes(event.key)) gesture(event, 1);
  });
  let touchY: number | undefined;
  addEventListener(
    "touchstart",
    (event) => {
      touchY = event.touches[0]?.clientY;
    },
    { passive: true },
  );
  addEventListener(
    "touchmove",
    (event) => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== undefined && nextY !== undefined) gesture(event, touchY - nextY);
      touchY = nextY;
    },
    { passive: true },
  );
  addEventListener(
    "touchend",
    () => {
      touchY = undefined;
    },
    { passive: true },
  );
  addEventListener(
    "touchcancel",
    () => {
      touchY = undefined;
    },
    { passive: true },
  );
}

export function withInlineWidgetScrollInput(document: string, token: string): string {
  return document.replace(
    "</head>",
    `<script>(${forwardScrollInput.toString()})(${JSON.stringify(token)});</script></head>`,
  );
}
