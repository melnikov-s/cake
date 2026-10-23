import { vi } from "vitest";
import type { DiagramRequest } from "../../../src/renderer/lib/diagram-contract";
import { renderDiagram } from "../../../src/renderer/lib/diagram-engine";

/** Browser transport/layout adapters only: real Pele parsing and SVG remain. */
export class DiagramTestWorker extends EventTarget {
  private stopped = false;
  postMessage(request: DiagramRequest) {
    queueMicrotask(() => {
      if (!this.stopped)
        this.dispatchEvent(new MessageEvent("message", { data: renderDiagram(request) }));
    });
  }
  terminate() {
    this.stopped = true;
  }
}

export function installDiagramMeasurement() {
  const original = Element.prototype.getBoundingClientRect;
  let width = 800;
  const observers = new Set<ResizeObserverCallback>();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return this.matches('[data-diagram="pele"]')
      ? new DOMRect(0, 0, width, 200)
      : original.call(this);
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        observers.add(this.callback);
      }
      unobserve() {}
      disconnect() {
        observers.delete(this.callback);
      }
    },
  );
  return {
    resize(next: number) {
      width = next;
      for (const callback of observers) callback([], {} as ResizeObserver);
    },
  };
}
