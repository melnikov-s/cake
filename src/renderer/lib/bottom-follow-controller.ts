const BOTTOM_TOLERANCE_PX = 1;
const USER_SCROLL_WINDOW_MS = 200;
const SCROLL_KEYS = new Set(["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

/**
 * Preserves a scroll container's bottom position across layout changes.
 *
 * The cached value is a DOM measurement, not application state: it records
 * whether the container was at bottom before its content changed. Explicit
 * user scroll input invalidates that measurement before the browser updates
 * scrollTop, preventing queued layout work from fighting the user.
 */
export class BottomFollowController {
  private scroller: HTMLElement | undefined;
  private alignBottom: (() => void) | undefined;
  private lastMeasuredAtBottom = true;
  private generation = 0;
  private alignmentFrame: number | undefined;
  private positionFrame: number | undefined;
  private userScrollTimer: ReturnType<typeof setTimeout> | undefined;
  private userScrollActive = false;
  private scrollbarPointerActive = false;
  private resizeObserver: ResizeObserver | undefined;
  private mutationObserver: MutationObserver | undefined;

  setAlignBottom(alignBottom: (() => void) | undefined) {
    this.alignBottom = alignBottom;
  }

  connectScroller(scroller: HTMLElement | undefined) {
    if (this.scroller === scroller) return;
    this.disconnectScroller();
    this.scroller = scroller;
    if (!scroller) return;

    scroller.addEventListener("wheel", this.onWheel, { passive: true });
    scroller.addEventListener("touchmove", this.onTouchMove, { passive: true });
    scroller.addEventListener("pointerdown", this.onPointerDown, { passive: true });
    scroller.addEventListener("pointermove", this.onPointerMove, { passive: true });
    scroller.addEventListener("pointerup", this.onPointerEnd, { passive: true });
    scroller.addEventListener("pointercancel", this.onPointerEnd, { passive: true });
    scroller.addEventListener("keydown", this.onKeyDown);
    scroller.addEventListener("scroll", this.onScroll, { passive: true });

    if ("ResizeObserver" in globalThis) {
      this.resizeObserver = new ResizeObserver(() => this.layoutChanged());
      this.observeLayoutElements();
    }
    if ("MutationObserver" in globalThis) {
      this.mutationObserver = new MutationObserver((records) => {
        if (records.some((record) => record.type === "childList")) this.observeLayoutElements();
        this.layoutChanged();
      });
      this.mutationObserver.observe(scroller, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  }

  /** Preserve bottom only when the DOM was at bottom before the layout changed. */
  layoutChanged() {
    if (!this.lastMeasuredAtBottom || this.positionFrame !== undefined) return;
    this.scheduleAlignment();
  }

  /** Submission explicitly moves to bottom, regardless of current geometry. */
  forceFollow() {
    this.clearUserScrollWindow();
    this.cancelPositionMeasurement();
    this.lastMeasuredAtBottom = true;
    this.scheduleAlignment();
  }

  /**
   * Runs an imperative non-tail scroll, then derives future following behavior
   * from the resulting DOM position. Callers do not declare a semantic mode.
   */
  changePosition(change: () => void) {
    this.invalidatePendingAlignment();
    this.clearUserScrollWindow();
    change();
    this.lastMeasuredAtBottom = this.isAtBottom();
    const scheduledGeneration = this.generation;
    this.positionFrame = -1;
    const frame = requestAnimationFrame(() => {
      this.positionFrame = undefined;
      if (this.generation !== scheduledGeneration) return;
      this.lastMeasuredAtBottom = this.isAtBottom();
    });
    // Test and non-browser hosts may invoke requestAnimationFrame synchronously.
    if (this.positionFrame !== undefined) this.positionFrame = frame;
  }

  dispose() {
    this.disconnectScroller();
    this.invalidatePendingAlignment();
    this.cancelPositionMeasurement();
    this.clearUserScrollWindow();
    this.alignBottom = undefined;
  }

  private scheduleAlignment() {
    if (this.alignmentFrame !== undefined) return;
    const scheduledGeneration = this.generation;
    this.alignBottom?.();
    this.alignmentFrame = -1;
    const frame = requestAnimationFrame(() => {
      this.alignmentFrame = undefined;
      if (
        !this.lastMeasuredAtBottom ||
        this.positionFrame !== undefined ||
        this.generation !== scheduledGeneration
      )
        return;
      this.alignBottom?.();
    });
    if (this.alignmentFrame !== undefined) this.alignmentFrame = frame;
  }

  private invalidatePendingAlignment() {
    this.generation += 1;
    if (this.alignmentFrame === undefined) return;
    cancelAnimationFrame(this.alignmentFrame);
    this.alignmentFrame = undefined;
  }

  private cancelPositionMeasurement() {
    if (this.positionFrame === undefined) return;
    cancelAnimationFrame(this.positionFrame);
    this.positionFrame = undefined;
  }

  private beginUserScroll() {
    this.invalidatePendingAlignment();
    this.cancelPositionMeasurement();
    this.lastMeasuredAtBottom = false;
    this.clearUserScrollWindow();
    this.userScrollActive = true;
    this.userScrollTimer = setTimeout(() => {
      this.userScrollActive = false;
      this.userScrollTimer = undefined;
    }, USER_SCROLL_WINDOW_MS);
  }

  private clearUserScrollWindow() {
    if (this.userScrollTimer !== undefined) clearTimeout(this.userScrollTimer);
    this.userScrollTimer = undefined;
    this.userScrollActive = false;
  }

  private isAtBottom() {
    const scroller = this.scroller;
    return (
      scroller !== undefined &&
      scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= BOTTOM_TOLERANCE_PX
    );
  }

  private observeLayoutElements() {
    const observer = this.resizeObserver;
    const scroller = this.scroller;
    if (!observer || !scroller) return;
    observer.disconnect();
    observer.observe(scroller);
    // Virtuoso's total content height is represented by a short chain of
    // wrapper elements. Observing that chain also covers non-virtualized lists.
    let element = scroller.firstElementChild;
    while (element instanceof HTMLElement) {
      observer.observe(element);
      element = element.firstElementChild;
    }
  }

  private disconnectScroller() {
    const scroller = this.scroller;
    if (scroller) {
      scroller.removeEventListener("wheel", this.onWheel);
      scroller.removeEventListener("touchmove", this.onTouchMove);
      scroller.removeEventListener("pointerdown", this.onPointerDown);
      scroller.removeEventListener("pointermove", this.onPointerMove);
      scroller.removeEventListener("pointerup", this.onPointerEnd);
      scroller.removeEventListener("pointercancel", this.onPointerEnd);
      scroller.removeEventListener("keydown", this.onKeyDown);
      scroller.removeEventListener("scroll", this.onScroll);
    }
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.resizeObserver = undefined;
    this.mutationObserver = undefined;
    this.scroller = undefined;
    this.scrollbarPointerActive = false;
  }

  private readonly onWheel = () => this.beginUserScroll();
  private readonly onTouchMove = () => this.beginUserScroll();

  private readonly onPointerDown = (event: PointerEvent) => {
    const scroller = this.scroller;
    if (!scroller || event.target !== scroller) return;
    const bounds = scroller.getBoundingClientRect();
    const onVerticalScrollbar = event.clientX >= bounds.left + scroller.clientWidth;
    if (!onVerticalScrollbar) return;
    this.scrollbarPointerActive = true;
    this.beginUserScroll();
  };

  private readonly onPointerMove = () => {
    if (this.scrollbarPointerActive) this.beginUserScroll();
  };

  private readonly onPointerEnd = () => {
    if (!this.scrollbarPointerActive) return;
    this.scrollbarPointerActive = false;
    this.lastMeasuredAtBottom = this.isAtBottom();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!SCROLL_KEYS.has(event.key)) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        'button, input, select, textarea, [contenteditable="true"], [contenteditable=""]',
      )
    )
      return;
    this.beginUserScroll();
  };

  private readonly onScroll = () => {
    if (this.userScrollActive || this.scrollbarPointerActive)
      this.lastMeasuredAtBottom = this.isAtBottom();
  };
}
