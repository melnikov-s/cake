/**
 * The single authority that moves a chat transcript's scroll position.
 *
 * The rule is deliberately small:
 *
 * - While the reader is at the bottom, the transcript follows new content.
 * - Opening a response pauses following, preserving its header for reading.
 * - Anywhere else, the transcript never scrolls for the reader. Layout changes
 *   (streaming text, new messages, tool output, cards, virtual measurement,
 *   viewport resizes) are compensated so the visible reading content keeps
 *   its exact on-screen position, including changes inside a tall row.
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
 * reveal or sent-message destination, and its own size compensation is disabled.
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
const readingSelector = "p, pre, h1, h2, h3, h4, h5, h6, li, td, th";

export interface TranscriptScrollOwner {
  /** Layout changed: pin the bottom while following, otherwise hold the reader's anchor still. */
  reconcile(): void;
  /** The reader sent a message: the one programmatic jump to the bottom. */
  scrollToBottomForSentMessage(navigation?: { itemKey: string; scrollToIndex(): void }): void;
  /**
   * Reveals the row with this stable item key. An unrendered virtual row is
   * reached through `scrollToIndex`; the reveal completes once it renders.
   */
  reveal(itemKey: string, scrollToIndex: () => void): void;
  /** A keyboard/linked message selection pauses following until the reader is at the bottom again. */
  setSelecting(selecting: boolean): void;
  /** A fullscreen artifact still belongs to a virtual row in this covered transcript. */
  setCovered(covered: boolean): void;
  dispose(): void;
}

export interface TranscriptScrollOwnerOptions {
  /** Whether to follow the bottom before the reader has scrolled. */
  following: boolean;
  /** Saved row placement; virtual index navigation only estimates this position. */
  restore?: { messageId: string; offset: number };
  /** Cancels the virtualizer's pending index-navigation retries without moving. */
  cancelVirtualNavigation(): void;
}

/**
 * All positions use content coordinates (viewport offset plus scrollTop), so
 * compensation cannot undo a native scroll whose event has not arrived yet.
 * The row is the fallback when its reading content is replaced or unmounted.
 */
type ReadingTarget = HTMLElement | { node: Text; offset: number };

interface Anchor {
  key: string;
  top: number;
  reading?: { target: ReadingTarget; top: number }[];
}

export function createTranscriptScrollOwner(
  scroller: HTMLElement,
  content: HTMLElement,
  options: TranscriptScrollOwnerOptions,
): TranscriptScrollOwner {
  let following = options.following;
  let selecting = false;
  let covered = false;
  let anchor: Anchor | undefined;
  let pendingReveal: string | undefined;
  let pendingBottom: string | undefined;
  let pendingRestore = options.restore;
  // The last scrollTop this owner wrote or observed. Any other position was
  // caused by someone else: the reader, or the browser clamping.
  let knownTop = scroller.scrollTop;
  let knownViewportHeight = scroller.clientHeight;
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
  const measuredRows = new Set<string>();
  const measuring = () => {
    let pending = false;
    for (const element of scroller.querySelectorAll<HTMLElement>(
      '[aria-label="Conversation"] > [data-known-size]',
    )) {
      const key = element.querySelector<HTMLElement>(rowSelector)?.dataset.transcriptItemKey;
      if (!key) continue;
      if (element.offsetHeight === Number(element.dataset.knownSize)) measuredRows.add(key);
      else if (!measuredRows.has(key)) pending = true;
    }
    // Resizes of already measured rows are real layout changes, not mount-time
    // estimates, including a virtual remount that starts with a loading body.
    // Compensate those immediately, before their next measurement.
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

  const readingTop = (target: ReadingTarget, element: HTMLElement) => {
    let geometry: HTMLElement | Range;
    if (target instanceof HTMLElement) geometry = target;
    else {
      // Keep the numeric offset, not a live Range: updating a streaming text
      // node resets a live Range's endpoints even when that node stays mounted.
      const range = document.createRange();
      const offset = Math.min(target.offset, Math.max(0, target.node.length - 1));
      range.setStart(target.node, offset);
      range.setEnd(target.node, Math.min(offset + 1, target.node.length));
      geometry = range;
    }
    return (
      geometry.getBoundingClientRect().top -
      (element.getBoundingClientRect().top - layoutTop(element)) -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop
    );
  };

  /**
   * Record visible prose blocks in the reading row, not the overscan rows.
   * Reconciliation holds the first displaced block: media can grow between two
   * visible paragraphs, leaving the earlier paragraph completely unchanged.
   * For a block crossing the top edge, record its visible text character before
   * the following blocks, so rewrapping preserves the line being read too.
   */
  const findReading = (element: HTMLElement): Anchor["reading"] => {
    const viewport = scroller.getBoundingClientRect();
    const reading: NonNullable<Anchor["reading"]> = [];
    let crossing: HTMLElement | undefined;
    let crossingCell: HTMLElement | undefined;
    for (const candidate of element.querySelectorAll<HTMLElement>(readingSelector)) {
      if (!candidate.textContent?.trim() || candidate.querySelector(readingSelector)) continue;
      const rect = candidate.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= viewport.top + 1) continue;
      if (rect.top >= viewport.bottom) break;
      if (rect.top >= viewport.top)
        reading.push({ target: candidate, top: readingTop(candidate, element) });
      else if (candidate.matches("td, th")) crossingCell ??= candidate;
      else crossing ??= candidate;
    }
    // A clipped table cell must not displace fully visible prose below the
    // table. When reading inside the table itself, keep its visible character.
    crossing ??= reading.length ? undefined : crossingCell;
    if (!crossing) return reading;
    const rect = crossing.getBoundingClientRect();
    const caret = document.caretRangeFromPoint?.(rect.left + 1, viewport.top + 1);
    if (
      !caret ||
      !crossing.contains(caret.startContainer) ||
      !(caret.startContainer instanceof Text)
    )
      return [{ target: crossing, top: readingTop(crossing, element) }, ...reading];
    const node = caret.startContainer;
    const target = { node, offset: Math.min(caret.startOffset, Math.max(0, node.length - 1)) };
    return [{ target, top: readingTop(target, element) }, ...reading];
  };

  /** The row crossing the top edge of the viewport, and the content being read. */
  const findAnchor = (includeReading = true): Anchor | undefined => {
    const viewportTop = scroller.getBoundingClientRect().top;
    for (const candidate of rows()) {
      const key = candidate.dataset.transcriptItemKey;
      const height = candidate.getBoundingClientRect().height;
      if (!key || height <= 0) continue;
      const top = layoutTop(candidate);
      if (top + height > viewportTop + 1)
        return {
          key,
          top: top - viewportTop + scroller.scrollTop,
          reading: includeReading ? findReading(candidate) : undefined,
        };
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
    const connectedReading = saved.reading?.filter(({ target }) =>
      element.contains(target instanceof HTMLElement ? target : target.node),
    );
    const readingDelta = connectedReading
      ?.map(({ target, top }) => readingTop(target, element) - top)
      .find((delta) => Math.abs(delta) >= 0.5);
    const delta = readingDelta ?? contentTop(element) - saved.top;
    if (Math.abs(delta) < 0.5) return;
    const before = scroller.scrollTop;
    write(before + delta);
    // The row itself need not move when content inside it grows. Keep its
    // fallback baseline separate from the reading content's compensation.
    saved.top = contentTop(element);
    for (const reading of connectedReading ?? []) reading.top = readingTop(reading.target, element);
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
    if (pendingReveal === undefined && pendingBottom === undefined && !pendingRestore) return;
    pendingReveal = undefined;
    pendingBottom = undefined;
    pendingRestore = undefined;
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
    // An upward browser clamp can preserve following, never restart it after
    // the reader paused it (for example by opening a response).
    if (pendingReveal === undefined)
      following = movedDown ? following || atBottom() : following && atEnd();
    if (!pendingMeasurements) anchor = findAnchor();
  };

  // Removing selection chrome grows the viewport before Virtuoso publishes the
  // expanded sections' height. That exact browser clamp is not an upward gesture.
  const observeViewport = () => {
    const growth = scroller.clientHeight - knownViewportHeight;
    knownViewportHeight = scroller.clientHeight;
    if (following && growth > 0 && Math.abs(knownTop - scroller.scrollTop - growth) <= endTolerance)
      knownTop = scroller.scrollTop;
  };

  const reconcile = () => {
    if (covered || !measurable()) return;
    observeViewport();
    const pendingMeasurements = measuring();
    if (positioning()) {
      knownTop = scroller.scrollTop;
      if (following) pin();
      return;
    }
    // Initial index navigation uses estimated row heights. Once the actual row
    // is revealed and measured, finish restoring its saved viewport offset.
    if (pendingRestore && !pendingMeasurements) {
      const restore = pendingRestore;
      const element = Array.from(rows()).find(
        (candidate) => candidate.dataset.transcriptAnchorId === restore.messageId,
      );
      if (element) {
        options.cancelVirtualNavigation();
        write(
          scroller.scrollTop +
            layoutTop(element) -
            scroller.getBoundingClientRect().top -
            restore.offset,
        );
        pendingRestore = undefined;
        anchor = findAnchor();
      }
    }
    // A native movement whose scroll event is still queued (layout commits and
    // ResizeObservers can run first) must not be pinned over.
    // A sent-message jump is virtual navigation until the destination has real
    // measurements. Estimate corrections/clamps during that jump are not input.
    if (scroller.scrollTop !== knownTop && pendingBottom === undefined)
      observeMovement(pendingMeasurements);
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
    if (pendingBottom !== undefined && !pendingMeasurements && row(pendingBottom)) {
      pendingBottom = undefined;
      options.cancelVirtualNavigation();
      pin();
    }
    // After a range settles, anchor the row actually being read, not an old
    // overscan row that may disappear on the next image resize/range commit.
    if (!selecting && pendingReveal === undefined && !pendingMeasurements) anchor = findAnchor();
    else if (!anchor) anchor = findAnchor();
  };

  const handleScroll = () => {
    if (covered || !measurable()) return;
    observeViewport();
    if (scroller.scrollTop === knownTop || positioning() || pendingBottom !== undefined) {
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
    // Chromium can drop Home while a PageUp animation is being corrected for
    // layout changes. Resolve this absolute reader destination synchronously,
    // through the same owner, rather than competing with the native animation.
    if (event.key === "Home" && !positioning() && !nestedScrollerConsumes(event.target, -1)) {
      intent(event.target, -1);
      event.preventDefault();
      write(0);
      anchor = undefined;
    } else if (["ArrowUp", "PageUp"].includes(event.key) || (event.key === " " && event.shiftKey))
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

  // Opening a response or toggling a task stretch is a reading action, not
  // new output. Capture before React changes its body so resize reconciliation
  // preserves the visible heading instead of pinning the bottom.
  const handleDisclosureClick = (event: MouseEvent) => {
    if (
      !(event.target instanceof Element) ||
      !event.target.closest(
        '[data-slot="response-disclosure"][aria-expanded="false"], [data-slot="task-section-disclosure"]',
      )
    )
      return;
    cancelReveal();
    following = false;
    // Disclosure deliberately preserves the heading, not prose after its body.
    anchor = findAnchor(false);
  };

  const abort = new AbortController();
  const listen = { signal: abort.signal, passive: true };
  scroller.addEventListener("click", handleDisclosureClick, {
    signal: abort.signal,
    capture: true,
  });
  scroller.addEventListener("pointerdown", cancelReveal, listen);
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
    scrollToBottomForSentMessage(navigation) {
      if (covered) return;
      cancelReveal();
      options.cancelVirtualNavigation();
      following = true;
      pendingBottom = navigation?.itemKey;
      pin();
      navigation?.scrollToIndex();
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
        cancelReveal();
        following = false;
        anchor = findAnchor();
      } else if (pendingBottom === undefined && measurable() && !positioning())
        following = atBottom();
    },
    setCovered(next) {
      if (next === covered) return;
      covered = next;
      cancelReveal();
      options.cancelVirtualNavigation();
      // Unlike message selection, a covered transcript must not resume following
      // when a queued scroll event or browser clamp lands at the bottom. Doing
      // so lets new output virtualize away the artifact's owning row.
      following = !next && !selecting && atBottom();
      knownTop = scroller.scrollTop;
      anchor = findAnchor();
    },
    dispose() {
      abort.abort();
      observer.disconnect();
    },
  };
}
