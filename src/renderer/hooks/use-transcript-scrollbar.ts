import { useLayoutEffect } from "react";

const scrollbarIdleMs = 500;
const scrollInputGapMs = 150;
const upKeys = new Set(["ArrowUp", "PageUp", "Home"]);
const downKeys = new Set(["ArrowDown", "PageDown", "End"]);

/** Paint the native thumb for reader input; leave scroll and focus ownership alone. */
export function useTranscriptScrollbar(scroller: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!scroller) return;
    const document = scroller.ownerDocument;
    const window = document.defaultView;
    if (!window) return;

    const listeners = new AbortController();
    const options = { signal: listeners.signal, passive: true };
    const inputOptions = { ...options, capture: true };
    const rightBorder = Number.parseFloat(window.getComputedStyle(scroller).borderRightWidth);
    let gutterPressed = false;
    let idleTimer: number | undefined;
    let touchY: number | undefined;
    let lastTop = scroller.scrollTop;
    let intent:
      | {
          event: Event;
          direction: number;
          time: number;
          height: number;
          width: number;
          extent: number;
          moved: boolean;
        }
      | undefined;

    const hide = () => scroller.removeAttribute("data-scrollbar-visible");
    const waitForIdle = () => {
      window.clearTimeout(idleTimer);
      if (!gutterPressed) idleTimer = window.setTimeout(hide, scrollbarIdleMs);
    };
    const reveal = () => {
      scroller.toggleAttribute("data-scrollbar-visible", true);
      waitForIdle();
    };
    const reset = () => {
      gutterPressed = false;
      touchY = undefined;
      intent = undefined;
      window.clearTimeout(idleTimer);
      hide();
    };
    const startScroll = (event: Event, direction: number) => {
      if (!event.isTrusted || event.defaultPrevented || !direction) return;
      intent = {
        event,
        direction,
        time: window.performance.now(),
        height: scroller.clientHeight,
        width: scroller.clientWidth,
        extent: scroller.scrollHeight,
        moved: false,
      };
    };
    const onScroll = (event: Event) => {
      if (event.target !== scroller) return;
      // Chromium can apply compositor scrolling before delivering wheel/touch
      // events, so use the last reported offset, not scrollTop at input time.
      const delta = scroller.scrollTop - lastTop;
      lastTop = scroller.scrollTop;
      if (!intent) return;
      const now = window.performance.now();
      // Scroll events themselves carry no intent. Require a matching movement
      // on this scrollport, not a nested scroll, pin or reflow.
      if (
        intent.event.defaultPrevented ||
        now - intent.time > scrollInputGapMs ||
        intent.height !== scroller.clientHeight ||
        intent.width !== scroller.clientWidth ||
        intent.extent !== scroller.scrollHeight
      ) {
        intent = undefined;
      } else if (delta) {
        if (Math.sign(delta) === intent.direction) {
          // Smooth native key/wheel scrolling and touch momentum can outlast
          // the original input. Keep qualifying those frames until scrollend.
          intent.time = now;
          intent.moved = true;
          reveal();
        } else {
          intent = undefined;
        }
      }
    };

    scroller.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey) startScroll(event, Math.sign(event.deltaY));
      },
      inputOptions,
    );
    scroller.addEventListener(
      "keydown",
      (event) => {
        if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.isContentEditable) return;
        if (target.closest("input, textarea, select, [role=textbox], [role=combobox]")) return;
        if (event.key === " ") {
          if (!target.closest("button, summary, [role=button], [role=checkbox]"))
            startScroll(event, event.shiftKey ? -1 : 1);
        } else if (upKeys.has(event.key)) startScroll(event, -1);
        else if (downKeys.has(event.key)) startScroll(event, 1);
      },
      inputOptions,
    );
    scroller.addEventListener(
      "touchstart",
      (event) => {
        touchY = event.touches.length === 1 ? event.touches[0]?.clientY : undefined;
      },
      inputOptions,
    );
    scroller.addEventListener(
      "touchmove",
      (event) => {
        const y = event.touches.length === 1 ? event.touches[0]?.clientY : undefined;
        if (touchY !== undefined && y !== undefined) startScroll(event, Math.sign(touchY - y));
        touchY = y;
      },
      inputOptions,
    );
    scroller.addEventListener("scroll", onScroll, options);
    scroller.addEventListener(
      "scrollend",
      () => {
        // Chromium may deliver the previous layout scroll's end after a new keydown.
        // Don't clear the new intent until it has produced matching movement.
        if (intent?.moved) intent = undefined;
      },
      options,
    );

    scroller.addEventListener(
      "mousedown",
      (event) => {
        if (
          !event.isTrusted ||
          event.button !== 0 ||
          event.target !== scroller ||
          scroller.scrollHeight <= scroller.clientHeight
        )
          return;
        // Chromium targets the scroller itself over the native gutter. Do not
        // change its geometry or capture the pointer, even when paint is hidden.
        const rect = scroller.getBoundingClientRect();
        const start = rect.left + scroller.clientLeft + scroller.clientWidth;
        if (
          event.clientX < start ||
          event.clientX >= rect.right - rightBorder ||
          event.clientY < rect.top ||
          event.clientY >= rect.top + scroller.clientTop + scroller.clientHeight
        )
          return;
        gutterPressed = true;
        reveal();
      },
      options,
    );
    window.addEventListener(
      "mouseup",
      (event) => {
        if (!gutterPressed || event.button !== 0) return;
        gutterPressed = false;
        waitForIdle();
      },
      inputOptions,
    );
    window.addEventListener("blur", reset, options);
    document.addEventListener("visibilitychange", reset, options);
    return () => {
      listeners.abort();
      reset();
    };
  }, [scroller]);
}
