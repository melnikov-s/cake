import { useLayoutEffect } from "react";

const scrollbarIdleMs = 500;

/** Reveal the native transcript thumb without changing the scrollport or intercepting input. */
export function useTranscriptScrollbar(scroller: HTMLElement | null) {
  useLayoutEffect(() => {
    if (!scroller) return;
    const document = scroller.ownerDocument;
    const window = document.defaultView;
    if (!window) return;

    const listeners = new AbortController();
    const options = { signal: listeners.signal };
    const rightBorder = Number.parseFloat(window.getComputedStyle(scroller).borderRightWidth);
    let overGutter = false;
    let gutterPressed = false;
    let idleTimer: number | undefined;

    const reset = () => {
      window.clearTimeout(idleTimer);
      scroller.removeAttribute("data-scrollbar-visible");
    };
    const waitForIdle = () => {
      window.clearTimeout(idleTimer);
      if (!overGutter && !gutterPressed) idleTimer = window.setTimeout(reset, scrollbarIdleMs);
    };
    const reveal = () => {
      scroller.toggleAttribute("data-scrollbar-visible", true);
      waitForIdle();
    };
    const setOverGutter = (next: boolean) => {
      if (overGutter === next) return;
      overGutter = next;
      if (next) reveal();
      else waitForIdle();
    };
    const hitsGutter = (event: MouseEvent) => {
      // Chromium targets the scroller itself over its native gutter, not the descendants.
      if (event.target !== scroller) return false;
      const rect = scroller.getBoundingClientRect();
      const start = rect.left + scroller.clientLeft + scroller.clientWidth;
      return (
        event.clientX >= start &&
        event.clientX < rect.right - rightBorder &&
        event.clientY >= rect.top &&
        event.clientY < rect.bottom
      );
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!gutterPressed || event.button !== 0) return;
      gutterPressed = false;
      // Chromium can suppress mousemoves while its scrollbar owns the drag.
      overGutter = hitsGutter(event);
      waitForIdle();
    };
    const onBlur = () => {
      overGutter = false;
      gutterPressed = false;
      reset();
    };

    scroller.addEventListener("scroll", reveal, { ...options, passive: true });
    scroller.addEventListener("mousemove", (event) => setOverGutter(hitsGutter(event)), {
      ...options,
      capture: true,
    });
    scroller.addEventListener("mouseleave", () => setOverGutter(false), options);
    scroller.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 0 || !hitsGutter(event)) return;
        gutterPressed = true;
        reveal();
      },
      options,
    );
    window.addEventListener("mouseup", onMouseUp, { ...options, capture: true });
    window.addEventListener("blur", onBlur, options);
    document.addEventListener("visibilitychange", onBlur, options);
    return () => {
      listeners.abort();
      reset();
    };
  }, [scroller]);
}
