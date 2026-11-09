/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTranscriptScrollOwner } from "../../../src/renderer/lib/transcript-scroll-owner";

describe("transcript jump-to-bottom visibility", () => {
  let scroller: HTMLDivElement;
  let owner: ReturnType<typeof createTranscriptScrollOwner>;
  let viewport: number;
  let height: number;
  let resize: () => void;
  let visibility = vi.fn<(visible: boolean) => void>();

  beforeEach(() => {
    viewport = 600;
    height = 3000;
    visibility = vi.fn<(visible: boolean) => void>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    scroller = document.createElement("div");
    const content = document.createElement("div");
    scroller.append(content);
    document.body.append(scroller);
    let top = 0;
    Object.defineProperties(scroller, {
      clientHeight: { get: () => viewport },
      scrollHeight: { get: () => height },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = Math.max(0, Math.min(value, height - viewport));
        },
      },
    });
    owner = createTranscriptScrollOwner(scroller, content, {
      following: false,
      cancelVirtualNavigation: vi.fn(),
      onJumpToBottomVisibilityChange: visibility,
    });
  });

  afterEach(() => {
    owner.dispose();
    scroller.remove();
    vi.unstubAllGlobals();
  });

  it.each([
    [601, true],
    [600, false],
    [599, false],
    [2, false],
    [0, false],
  ])("shows iff the remaining distance (%i) exceeds the actual viewport", (gap, visible) => {
    scroller.scrollTop = height - viewport - gap;
    scroller.dispatchEvent(new Event("scroll"));
    expect(visibility).toHaveBeenLastCalledWith(visible);
  });

  it("hides for non-scrollable or unmeasurable content", () => {
    height = viewport;
    resize();
    expect(visibility).toHaveBeenLastCalledWith(false);
    height = 200;
    resize();
    expect(visibility).toHaveBeenLastCalledWith(false);
    viewport = 0;
    resize();
    expect(visibility).toHaveBeenLastCalledWith(false);
  });

  it("reacts to resize and streaming/layout growth without moving the reader", () => {
    height = 1200;
    resize();
    expect(visibility).toHaveBeenLastCalledWith(false);
    height++;
    resize();
    expect(visibility).toHaveBeenLastCalledWith(true);
    viewport = 601;
    resize();
    expect(visibility).toHaveBeenLastCalledWith(false);
    viewport = 500;
    resize();
    expect(visibility).toHaveBeenLastCalledWith(true);
    expect(scroller.scrollTop).toBe(0);
    const notifications = visibility.mock.calls.length;
    owner.reconcile();
    resize();
    expect(visibility).toHaveBeenCalledTimes(notifications);
  });

  it("explicitly jumps to the real bottom, hides, and follows subsequent growth", () => {
    owner.reconcile();
    expect(visibility).toHaveBeenLastCalledWith(true);
    owner.jumpToBottom();
    expect(scroller.scrollTop).toBe(height - viewport);
    expect(visibility).toHaveBeenLastCalledWith(false);
    height += 200;
    resize();
    expect(scroller.scrollTop).toBe(height - viewport);
    expect(visibility).toHaveBeenLastCalledWith(false);
    // Upward reading input still cancels this explicit destination.
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    scroller.scrollTop -= 800;
    scroller.dispatchEvent(new Event("scroll"));
    const readingTop = scroller.scrollTop;
    height += 200;
    resize();
    expect(scroller.scrollTop).toBe(readingTop);
    expect(visibility).toHaveBeenLastCalledWith(true);
  });

  it("hides while covered and recomputes when the transcript is uncovered", () => {
    owner.reconcile();
    owner.setCovered(true);
    expect(visibility).toHaveBeenLastCalledWith(false);
    owner.setCovered(false);
    expect(visibility).toHaveBeenLastCalledWith(true);
  });
});
