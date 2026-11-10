/**
 * The one place that decides when a chat transcript follows new output.
 *
 * Legend List does the scrolling. `maintainScrollAtEnd` keeps the end pinned
 * while the transcript follows it, and `maintainVisibleContentPosition` keeps
 * the visible content still otherwise. The list notices reader input (wheel,
 * keys, touch, scrollbar) before it scrolls and stops following.
 *
 * Cake's rules, all here:
 *
 * 1. Only a reader action scrolls to the end: sending, the jump-to-bottom
 *    control, or arrowing past the newest message (`followEnd`).
 * 2. Upward reader input stops following for good (`released`). The list alone
 *    would start again within a pixel of the end; Cake requires the reader to
 *    actually return to the end.
 * 3. A selected message or a fullscreen reader over the transcript pauses
 *    following, so new output cannot move them (`paused`).
 * 4. Input inside an embedded widget frame counts too. The list cannot see it;
 *    the frame forwards its direction as a `transcript-reader-input` event.
 * 5. The reader scrolling down to the very end resumes following. Movement the
 *    list makes itself (pins, position corrections) never does.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { LegendListRef, MaintainScrollAtEndOptions } from "@legendapp/list/react";

/** Every kind of growth stays pinned while following, without animation. */
const followingEnd: MaintainScrollAtEndOptions = {
  animated: false,
  on: { dataChange: true, itemLayout: true, layout: true, footerLayout: true },
};
const upKeys = new Set(["ArrowUp", "PageUp", "Home"]);
const downKeys = new Set(["ArrowDown", "PageDown", "End", " "]);

/** A nested scroll area (code block, work log) that can still move takes the gesture itself. */
function nestedScrollerTakes(scroller: HTMLElement, target: EventTarget | null, direction: number) {
  for (
    let element = target instanceof Element ? target : null;
    element && element !== scroller;
    element = element.parentElement
  ) {
    if (!(element instanceof HTMLElement) || element.scrollHeight <= element.clientHeight) continue;
    if (!["auto", "scroll"].includes(getComputedStyle(element).overflowY)) continue;
    if (direction < 0 ? element.scrollTop > 0 : distanceFromEnd(element) >= 1) return true;
  }
  return false;
}

/** The rendered distance from the end; the list's own model can still hold estimates. */
const distanceFromEnd = (scroller: HTMLElement) =>
  scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
/** Pinned scroll offsets can be fractional; a whole pixel away is the reader's. */
const atEnd = (scroller: HTMLElement) => distanceFromEnd(scroller) < 1;

export interface TranscriptFollow {
  /** Pass to the list's `maintainScrollAtEnd`. */
  maintainScrollAtEnd: MaintainScrollAtEndOptions | false;
  /** More than a screen of newer content lies below the viewport. */
  jumpVisible: boolean;
  /** The reader asked for the newest content: scroll to the end and follow it. */
  followEnd(): void;
  /** Explicit navigation elsewhere (a selected or linked message): stop following. */
  stopFollowing(): void;
  /** Call on size changes to refresh `jumpVisible`. */
  update(): void;
}

export function useTranscriptFollow({
  list,
  scroller,
  paused,
  initiallyFollowing,
}: {
  list: RefObject<LegendListRef | null>;
  scroller: HTMLElement | null;
  paused: boolean;
  initiallyFollowing: boolean;
}): TranscriptFollow {
  const [released, setReleased] = useState(!initiallyFollowing);
  const [endRequest, setEndRequest] = useState(0);
  const [jumpVisible, setJumpVisible] = useState(false);
  // Read by event handlers between renders.
  const state = useRef({
    released: !initiallyFollowing,
    paused,
    lastScroll: 0,
    /** The direction of the reader's latest scrolling input: -1 up, 1 down, 0 none. */
    input: 0,
  });
  state.current.paused = paused;
  const release = useCallback(() => {
    state.current.released = true;
    setReleased(true);
  }, []);
  const followEnd = useCallback(() => {
    state.current.released = false;
    state.current.input = 0;
    setReleased(false);
    // Scroll once the list has the following configuration again (below).
    setEndRequest((request) => request + 1);
  }, []);
  useLayoutEffect(() => {
    if (endRequest) void list.current?.scrollToEnd({ animated: false });
  }, [endRequest, list]);
  const update = useCallback(() => {
    setJumpVisible(!!scroller && distanceFromEnd(scroller) > scroller.clientHeight);
  }, [scroller]);
  useEffect(update, [update]);
  useEffect(() => {
    const current = list.current;
    if (!scroller || !current) return;
    // Upward reader input stops following before the browser scrolls, so no
    // pin can land in between.
    const input = (direction: number, target: EventTarget | null = null) => {
      if (direction && nestedScrollerTakes(scroller, target, direction)) return;
      state.current.input = direction;
      if (direction === -1 && !state.current.released && !state.current.paused) {
        current.cancelScroll();
        release();
      }
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) input(Math.sign(event.deltaY), event.target);
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        (event.target instanceof HTMLElement && event.target.isContentEditable)
      )
        return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select"))
        return;
      if (upKeys.has(event.key) || (event.key === " " && event.shiftKey)) input(-1, event.target);
      else if (downKeys.has(event.key)) input(1, event.target);
    };
    let touchY: number | undefined;
    const touchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const touchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      // A finger moving down scrolls the content up.
      if (y !== undefined && touchY !== undefined && y !== touchY)
        input(y > touchY ? -1 : 1, event.target);
      touchY = y;
    };
    // A scrollbar drag can go either way; the scroll position tells which.
    const pointer = (event: PointerEvent) => {
      if (event.target === scroller) input(Number.NaN);
    };
    const pointerEnd = () => {
      if (Number.isNaN(state.current.input)) input(0);
    };
    const embedded = (event: Event) => {
      if (!(event instanceof CustomEvent) || (event.detail !== -1 && event.detail !== 1)) return;
      input(event.detail);
    };
    const handleScroll = () => {
      const { input: direction, lastScroll } = state.current;
      const movedDown = scroller.scrollTop > lastScroll;
      state.current.lastScroll = scroller.scrollTop;
      if (Number.isNaN(direction) && !movedDown && !state.current.paused) release();
      // Only the reader moves a released transcript down to its very end.
      if (state.current.released && !state.current.paused && direction !== -1 && direction !== 0)
        if (movedDown && atEnd(scroller)) followEnd();
      update();
    };
    // The list also stops following on input this owner does not classify (a
    // scrollbar press). It may stop and resume within one settle step.
    const unlisten = current.getState().listen("isFollowingEnd", (following) => {
      if (following || state.current.paused) return;
      queueMicrotask(() => {
        if (!state.current.paused && !list.current?.getState().isFollowingEnd) release();
      });
    });
    state.current.lastScroll = scroller.scrollTop;
    // Capture: see each event before the list's own listeners act on it.
    const options = { capture: true, passive: true };
    scroller.addEventListener("wheel", wheel, options);
    scroller.addEventListener("keydown", key, options);
    scroller.addEventListener("touchstart", touchStart, options);
    scroller.addEventListener("touchmove", touchMove, options);
    scroller.addEventListener("pointerdown", pointer, options);
    document.addEventListener("pointerup", pointerEnd, options);
    document.addEventListener("pointercancel", pointerEnd, options);
    scroller.addEventListener("transcript-reader-input", embedded, options);
    scroller.addEventListener("scroll", handleScroll, options);
    return () => {
      unlisten();
      scroller.removeEventListener("wheel", wheel, options);
      scroller.removeEventListener("keydown", key, options);
      scroller.removeEventListener("touchstart", touchStart, options);
      scroller.removeEventListener("touchmove", touchMove, options);
      scroller.removeEventListener("pointerdown", pointer, options);
      document.removeEventListener("pointerup", pointerEnd, options);
      document.removeEventListener("pointercancel", pointerEnd, options);
      scroller.removeEventListener("transcript-reader-input", embedded, options);
      scroller.removeEventListener("scroll", handleScroll, options);
    };
  }, [followEnd, list, release, scroller, update]);
  return {
    maintainScrollAtEnd: paused || released ? false : followingEnd,
    jumpVisible,
    followEnd,
    stopFollowing: useCallback(() => {
      list.current?.cancelScroll();
      release();
    }, [list, release]),
    update,
  };
}
