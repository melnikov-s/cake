/**
 * @vitest-environment jsdom
 */
import { createRef } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { Virtuoso, VirtuosoMockContext, type VirtuosoHandle } from "react-virtuoso";
import { afterEach, expect, it, vi } from "vitest";
import { VirtualizedConversation } from "../../../src/renderer/components/ai-elements/conversation";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["normal", ""])(
  "settles row measurements without republishing scroll/gap inputs (gap: %j)",
  (gap) => {
    const observers: { target: Element; callback: () => void }[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe(target: Element) {
          observers.push({
            target,
            callback: () => this.callback([{ target } as ResizeObserverEntry], this),
          });
        }
        unobserve(target: Element) {
          for (let index = observers.length - 1; index >= 0; index--)
            if (observers[index]?.target === target) observers.splice(index, 1);
        }
        disconnect() {}
      },
    );
    // Virtuoso measures ResizeObserver notifications on the next frame.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", () => {});
    vi.spyOn(HTMLElement.prototype, "offsetParent", "get").mockReturnValue(document.body);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return new DOMRect(0, 0, 800, this.dataset.index === undefined ? 600 : 100);
      },
    );
    const style = document.createElement("style");
    // The empty value is jsdom's default, not a claim about Chromium's CSS.
    // It makes redundant gap publication non-convergent and exposes the nested
    // render loop. The normal value also checks the boundary with stable inputs.
    style.textContent = gap ? `div { row-gap: ${gap}; column-gap: ${gap}; }` : "";
    document.head.append(style);
    const scroller = document.createElement("div");
    document.body.append(scroller);
    // Size-result commits must not resample and publish the scroll/resize inputs
    // that select the rendered range. Native notifications own those inputs.
    let geometryReads = 0;
    Object.defineProperties(scroller, {
      offsetHeight: {
        get: () => {
          geometryReads++;
          return 600;
        },
      },
      scrollHeight: { value: 2000 },
    });
    const data = Array.from({ length: 20 }, (_, index) => `Message ${index}`);
    const itemContent = vi.fn((_: number, message: string) => message);
    try {
      render(
        <VirtualizedConversation
          data={data}
          customScrollParent={scroller}
          computeItemKey={(_, message) => message}
          itemContent={itemContent}
          skipUpwardScrollCompensation
        />,
        { container: scroller },
      );
      act(() => {
        for (const observer of [...observers])
          if (observer.target.getAttribute("data-viewport-type") === "window") observer.callback();
        for (const frame of frames.splice(0)) frame(0);
      });
      expect(scroller.textContent).toContain("Message 0");
      expect(scroller.querySelector('[data-known-size="100"]')).not.toBeNull();
      // The initial scroll subscription samples once; size-result commits do not.
      expect(geometryReads).toBe(1);
      expect(itemContent.mock.calls.length).toBeLessThan(200);
    } finally {
      cleanup();
      scroller.remove();
      style.remove();
    }
  },
);

// Keep the installed virtualizer real: the transcript tests control this boundary
// and cannot detect a stale dependency missing Cake's patched imperative API.
it("exposes index-navigation cancellation on the installed Virtuoso handle", () => {
  const ref = createRef<VirtuosoHandle>();
  render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 100 }}>
      <Virtuoso ref={ref} data={["Message"]} itemContent={(_, message) => message} />
    </VirtuosoMockContext.Provider>,
  );

  expect(ref.current).not.toBeNull();
  expect(ref.current?.cancelScrollToIndex).toBeTypeOf("function");
  expect(() => ref.current!.cancelScrollToIndex()).not.toThrow();
});
