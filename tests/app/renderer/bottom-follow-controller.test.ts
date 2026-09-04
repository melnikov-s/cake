/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BottomFollowController } from "../../../src/renderer/lib/bottom-follow-controller";

describe("BottomFollowController", () => {
  const controllers: BottomFollowController[] = [];

  afterEach(() => {
    for (const controller of controllers) controller.dispose();
    controllers.length = 0;
    vi.restoreAllMocks();
  });

  function createController() {
    const controller = new BottomFollowController();
    const scroller = document.createElement("div");
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 200 },
    });
    scroller.scrollTop = 800;
    controller.connectScroller(scroller);
    controllers.push(controller);
    return { controller, scroller };
  }

  it("invalidates queued bottom alignment as soon as wheel input begins", () => {
    let queuedFrame: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      queuedFrame = callback;
      return 1;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { controller, scroller } = createController();
    const alignBottom = vi.fn();
    controller.setAlignBottom(alignBottom);

    controller.layoutChanged();
    expect(alignBottom).toHaveBeenCalledOnce();
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    queuedFrame?.(performance.now());

    expect(alignBottom).toHaveBeenCalledOnce();
    controller.layoutChanged();
    expect(alignBottom).toHaveBeenCalledOnce();
  });

  it("derives resumed following when user input moves the DOM to bottom", () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { controller, scroller } = createController();
    const alignBottom = vi.fn();
    controller.setAlignBottom(alignBottom);

    scroller.scrollTop = 300;
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    scroller.dispatchEvent(new Event("scroll"));

    // Content layout alone cannot restore the cached pre-mutation bottom
    // measurement after the user has scrolled away.
    controller.layoutChanged();
    expect(frames).toHaveLength(0);

    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    scroller.scrollTop = 800;
    scroller.dispatchEvent(new Event("scroll"));
    controller.layoutChanged();
    expect(frames).toHaveLength(1);
    expect(alignBottom).toHaveBeenCalledOnce();

    frames[0]!(performance.now());
    expect(alignBottom).toHaveBeenCalledTimes(2);
  });

  it("forces the bottom immediately on submission", () => {
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);
    const { controller, scroller } = createController();
    const alignBottom = vi.fn();
    controller.setAlignBottom(alignBottom);
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));

    controller.forceFollow();

    expect(alignBottom).toHaveBeenCalledOnce();
  });

  it("derives following from the DOM after non-tail programmatic navigation", () => {
    let positionFrame: FrameRequestCallback | undefined;
    vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation((callback) => {
      positionFrame = callback;
      return 1;
    });
    vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => undefined);
    const { controller, scroller } = createController();
    const alignBottom = vi.fn();
    controller.setAlignBottom(alignBottom);

    controller.changePosition(() => {
      scroller.scrollTop = 300;
    });
    positionFrame?.(performance.now());
    controller.layoutChanged();

    expect(alignBottom).not.toHaveBeenCalled();
  });
});
