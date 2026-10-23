/**
 * The single authority that moves a chat transcript's scroll position.
 *
 * The rule is deliberately small:
 *
 * - While the reader is at the bottom, the transcript follows new content.
 * - Anywhere else, the transcript never scrolls for the reader. Layout changes
 *   (streaming text, new messages, tool output, cards, virtual measurement,
 *   viewport resizes) are compensated so the row at the top of the viewport
 *   keeps its exact on-screen position.
 *
 * Only the reader may start following again, by scrolling back to the bottom.
 * The one programmatic jump to the bottom is sending a message. Revealing a
 * message the reader selected with the keyboard (or a link) is the only other
 * movement, and it stops following.
 *
 * Any upward movement that leaves the very end is the reader, whatever caused
 * it: wheel, keys, touch, a scrollbar drag, find-in-page, or a gesture over an
 * iframe that never reaches this document as input. Following stops before
 * anything can pin over it. Only a browser clamp (content shrank) moves up and
 * still lands exactly at the end.
 *
 * Every layout trigger calls `reconcile()`. Nothing else in the renderer writes
 * this scroller's `scrollTop`; the virtualizer only moves it for an explicit
 * reveal of an unrendered row, and its own size compensation is disabled.
 */

/** Distance from the bottom, in CSS pixels, at which moving down resumes following. */
const bottomThreshold = 2;
/**
 * A pinned scroller can sit a fraction of a pixel short of its maximum (fractional
 * device pixels). Any upward movement of a pixel or more is the reader's.
 */
const endTolerance = 1;
const revealMargin = 16;
const rowSelector = "[data-transcript-item-key]";

export interface TranscriptScrollOwner {
  /** Layout changed: pin the bottom while following, otherwise hold the reader's anchor still. */
  reconcile(): void;
  /** The reader sent a message: the one programmatic jump to the bottom. */
  scrollToBottomForSentMessage(): void;
  /**
   * Reveals the row with this stable item key. An unrendered virtual row is
   * reached through `scrollToIndex`; the reveal completes once it renders.
   */
  reveal(itemKey: string, scrollToIndex: () => void): void;
  /** A keyboard/linked message selection pauses following until the reader is at the bottom again. */
  setSelecting(selecting: boolean): void;
  dispose(): void;
}

export interface TranscriptScrollOwnerOptions {
  /** Whether to follow the bottom before the reader has scrolled. */
  following: boolean;
  /** Cancels the virtualizer's pending index-navigation retries without moving. */
  cancelVirtualNavigation(): void;
}

/**
 * An anchor is a row and its top edge in *content* coordinates (viewport offset
 * plus scrollTop). That value does not change when the reader scrolls, only
 * when layout above the row changes, so compensation can never undo a native
 * scroll whose `scroll` event has not been dispatched yet.
 */
interface Anchor {
  key: string;
  top: number;
}

export function createTranscriptScrollOwner(
  scroller: HTMLElement,
  content: HTMLElement,
  options: TranscriptScrollOwnerOptions,
): TranscriptScrollOwner {
  let following = options.following;
  let selecting = false;
  let anchor: Anchor | undefined;
  let pendingReveal: string | undefined;
  // The last scrollTop this owner wrote or observed. Any other position was
  // caused by someone else: the reader, or the browser clamping.
  let knownTop = scroller.scrollTop;
  let touchY: number | undefined;

  const measurable = () => scroller.isConnected && scroller.clientHeight > 0;
  // Virtuoso hides the list while it settles the initial position. Its moves
  // during that time are not reading positions.
  const positioning = () => {
    const list = scroller.querySelector('[aria-label="Conversation"]');
    return list !== null && getComputedStyle(list).visibility === "hidden";
  };
  // A range commit inserts real rows using estimated sizes first. Its padding
  // is not authoritative until Virtuoso measures those rows. Compensating the
  // intermediate geometry can move the range again and unmount our anchor.
  const measuredRows = new WeakSet<HTMLElement>();
  const measuring = () => {
    let pending = false;
    for (const element of scroller.querySelectorAll<HTMLElement>(
      '[aria-label="Conversation"] > [data-known-size]',
    )) {
      if (element.offsetHeight === Number(element.dataset.knownSize)) measuredRows.add(element);
      else if (!measuredRows.has(element)) pending = true;
    }
    // Resizes of already measured rows are real layout changes, not mount-time
    // estimates. Compensate those immediately, before their next measurement.
    return pending;
  };
  const gap = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  const atBottom = () => gap() <= bottomThreshold;
  const atEnd = () => gap() < endTolerance;
  const write = (top: number) => {
    scroller.scrollTop = top;
    knownTop = scroller.scrollTop;
  };
  const rows = () => scroller.querySelectorAll<HTMLElement>(rowSelector);
  const row = (key: string) =>
    Array.from(rows()).find((candidate) => candidate.dataset.transcriptItemKey === key);
  /**
   * A row's layout top in viewport coordinates. A live arrival's entrance
   * animation translates its row for a moment; that is paint, not layout, and
   * must not be "compensated" into a scroll.
   */
  const layoutTop = (element: HTMLElement) => {
    const top = element.getBoundingClientRect().top;
    const transform = getComputedStyle(element).transform;
    return !transform || transform === "none" ? top : top - new DOMMatrixReadOnly(transform).m42;
  };
  const contentTop = (element: HTMLElement) =>
    layoutTop(element) - scroller.getBoundingClientRect().top + scroller.scrollTop;

  /** The row crossing the top edge of the viewport. */
  const findAnchor = (): Anchor | undefined => {
    const viewportTop = scroller.getBoundingClientRect().top;
    for (const candidate of rows()) {
      const key = candidate.dataset.transcriptItemKey;
      const height = candidate.getBoundingClientRect().height;
      if (!key || height <= 0) continue;
      const top = layoutTop(candidate);
      if (top + height > viewportTop + 1)
        return { key, top: top - viewportTop + scroller.scrollTop };
    }
    return undefined;
  };

  const pin = () => {
    if (gap() > 0) write(scroller.scrollHeight);
  };

  const holdAnchor = () => {
    const saved = anchor;
    const element = saved && row(saved.key);
    if (!saved || !element) {
      anchor = findAnchor();
      return;
    }
    const delta = contentTop(element) - saved.top;
    if (Math.abs(delta) < 0.5) return;
    const before = scroller.scrollTop;
    write(before + delta);
    // Keep any sub-pixel remainder (or a clamped write) in the baseline so it
    // is corrected by a later change instead of accumulating as drift.
    saved.top += scroller.scrollTop - before;
  };

  /**
   * `nearest` moves a rendered row the minimum distance; `start` aligns a row
   * reached through virtual navigation, whose estimated position is arbitrary.
   */
  const revealRow = (element: HTMLElement, align: "nearest" | "start") => {
    const viewport = scroller.getBoundingClientRect();
    const dockInset =
      Number.parseFloat(getComputedStyle(scroller).getPropertyValue("--composer-dock-height")) || 0;
    const top = viewport.top + revealMargin;
    const bottom = viewport.bottom - dockInset - revealMargin;
    const rect = element.getBoundingClientRect();
    // Tall rows align their top; rows that fit move the minimum distance.
    const delta =
      align === "start" || rect.top < top || rect.height > bottom - top
        ? rect.top - top
        : rect.bottom > bottom
          ? rect.bottom - bottom
          : 0;
    if (Math.abs(delta) >= 1) write(scroller.scrollTop + delta);
    // Hold the selected row itself still until the reader scrolls.
    const key = element.dataset.transcriptItemKey;
    anchor = key ? { key, top: contentTop(element) } : findAnchor();
  };

  const cancelReveal = () => {
    if (pendingReveal === undefined) return;
    pendingReveal = undefined;
    options.cancelVirtualNavigation();
  };

  /**
   * Someone else moved the viewport since this owner last looked: the reader, or
   * a browser clamp. Classify it before anything can pin over it.
   */
  const observeMovement = (pendingMeasurements: boolean) => {
    const movedDown = scroller.scrollTop > knownTop;
    // First compensate any layout change that has not been reconciled yet
    // (content coordinates ignore the movement itself).
    if (!following && !pendingMeasurements) holdAnchor();
    knownTop = scroller.scrollTop;
    // Virtuoso's scrollToIndex moves for a pending reveal; that is not the reader.
    if (pendingReveal === undefined) following = movedDown ? following || atBottom() : atEnd();
    if (!pendingMeasurements) anchor = findAnchor();
  };

  const reconcile = () => {
    if (!measurable()) return;
    const pendingMeasurements = measuring();
    if (positioning()) {
      knownTop = scroller.scrollTop;
      if (following) pin();
      return;
    }
    // A native movement whose scroll event is still queued (layout commits and
    // ResizeObservers can run first) must not be pinned over.
    if (scroller.scrollTop !== knownTop) observeMovement(pendingMeasurements);
    if (!following && pendingMeasurements) return;
    if (following) pin();
    else holdAnchor();
    if (pendingReveal !== undefined) {
      const element = row(pendingReveal);
      if (element) {
        // The target rendered: finish with real geometry and stop the
        // virtualizer's estimate-based retries from moving it again.
        pendingReveal = undefined;
        options.cancelVirtualNavigation();
        revealRow(element, "start");
      }
    }
    if (!anchor) anchor = findAnchor();
  };

  const handleScroll = () => {
    if (!measurable()) return;
    if (scroller.scrollTop === knownTop || positioning()) {
      reconcile();
      return;
    }
    observeMovement(measuring());
    if (following) pin();
  };

  /** An uncontained nested scroller that can still move consumes the gesture itself. */
  const nestedScrollerConsumes = (target: EventTarget | null, direction: number) => {
    if (!(target instanceof Element)) return true;
    for (
      let element: Element | null = target;
      element && element !== scroller;
      element = element.parentElement
    ) {
      if (!(element instanceof HTMLElement)) continue;
      const style = getComputedStyle(element);
      if (!["auto", "scroll"].includes(style.overflowY)) continue;
      const canScroll =
        direction < 0
          ? element.scrollTop > 0
          : element.scrollTop + element.clientHeight < element.scrollHeight;
      if (canScroll || ["contain", "none"].includes(style.overscrollBehaviorY)) return true;
    }
    return false;
  };

  /**
   * Reader input acts before its scroll event so a layout change in between
   * cannot pin the reader back down. Upward input stops following at once;
   * downward input at the bottom (which may not move) resumes it. Movement
   * without such input is classified by `observeMovement`.
   */
  const intent = (target: EventTarget | null, direction: number) => {
    if (direction === 0 || positioning() || nestedScrollerConsumes(target, direction)) return;
    cancelReveal();
    if (direction < 0) {
      if (following && scroller.scrollTop > 0) {
        following = false;
        anchor = findAnchor();
      }
    } else if (atBottom()) following = true;
  };

  const handleWheel = (event: WheelEvent) => intent(event.target, event.deltaY);
  const handleKeyDown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      !(event.target instanceof Element) ||
      event.target.closest('input, textarea, select, [contenteditable="true"]')
    )
      return;
    if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey))
      intent(event.target, -1);
    else if (["ArrowDown", "PageDown", "End", " "].includes(event.key)) intent(event.target, 1);
  };
  const handleTouchStart = (event: TouchEvent) => {
    touchY = event.touches[0]?.clientY;
  };
  const handleTouchMove = (event: TouchEvent) => {
    const nextY = event.touches[0]?.clientY;
    if (touchY !== undefined && nextY !== undefined) intent(event.target, touchY - nextY);
    touchY = nextY;
  };
  const handleTouchEnd = () => {
    touchY = undefined;
  };

  const abort = new AbortController();
  const listen = { signal: abort.signal, passive: true };
  scroller.addEventListener("scroll", handleScroll, listen);
  scroller.addEventListener("wheel", handleWheel, listen);
  scroller.addEventListener("keydown", handleKeyDown, { signal: abort.signal });
  scroller.addEventListener("touchstart", handleTouchStart, listen);
  scroller.addEventListener("touchmove", handleTouchMove, listen);
  scroller.addEventListener("touchend", handleTouchEnd, listen);
  scroller.addEventListener("touchcancel", handleTouchEnd, listen);
  // Row, footer, composer-dock and viewport size changes all land here before paint.
  const observer = new ResizeObserver(reconcile);
  observer.observe(content);
  observer.observe(scroller);

  return {
    reconcile,
    scrollToBottomForSentMessage() {
      cancelReveal();
      following = true;
      pin();
    },
    reveal(itemKey, scrollToIndex) {
      following = false;
      cancelReveal();
      const element = row(itemKey);
      if (element) {
        options.cancelVirtualNavigation();
        revealRow(element, "nearest");
        return;
      }
      pendingReveal = itemKey;
      scrollToIndex();
    },
    setSelecting(next) {
      if (next === selecting) return;
      selecting = next;
      if (next) {
        following = false;
        anchor = findAnchor();
      } else if (measurable() && !positioning()) following = atBottom();
    },
    dispose() {
      abort.abort();
      observer.disconnect();
    },
  };
}
