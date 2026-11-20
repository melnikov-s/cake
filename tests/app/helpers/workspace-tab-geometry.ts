import { act } from "@testing-library/react";
import { vi } from "vitest";

type MeasuredStage = "full" | "widget-icons" | "icons";

/**
 * jsdom has no layout: report a pane width for the tab strip and fixed natural
 * widths for its hidden per-stage measurement rows, then drive ResizeObserver.
 */
export function stubWorkspaceTabGeometry(required: Record<MeasuredStage, number>) {
  const callbacks = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly notify: () => void;
      constructor(callback: ResizeObserverCallback) {
        this.notify = () => callback([], this as unknown as ResizeObserver);
      }
      observe() {
        callbacks.add(this.notify);
      }
      unobserve() {}
      disconnect() {
        callbacks.delete(this.notify);
      }
    },
  );
  let available = 1000;
  const rect = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      const stage = this.dataset.measureStage as MeasuredStage | undefined;
      const width =
        this.dataset.slot === "workspace-tab-strip" ? available : stage ? required[stage] : 0;
      return DOMRect.fromRect({ width, height: 28 });
    });
  return {
    resize(width: number) {
      available = width;
      act(() => {
        for (const notify of callbacks) notify();
      });
    },
    [Symbol.dispose]() {
      rect.mockRestore();
    },
  };
}
