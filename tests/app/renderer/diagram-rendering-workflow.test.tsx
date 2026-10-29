/** @vitest-environment jsdom */
import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  diagramStreamingIdleTimeoutMs,
  diagramTimeoutMs,
  type DiagramRequest,
  type DiagramResponse,
} from "../../../src/renderer/lib/diagram-contract";
import { renderDiagram } from "../../../src/renderer/lib/diagram-engine";
import { DiagramTestWorker, installDiagramMeasurement } from "./diagram-browser-fixture";
import { renderMarkdown } from "./markdown-rendering-fixture";

const source = "```mermaid\nflowchart TB\nA[Player] --> B[Godot]\n```";
let measurement: ReturnType<typeof installDiagramMeasurement>;
const fonts = Object.getOwnPropertyDescriptor(document, "fonts");
beforeEach(() => {
  vi.useFakeTimers();
  measurement = installDiagramMeasurement();
  vi.stubGlobal("Worker", DiagramTestWorker);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (fonts) Object.defineProperty(document, "fonts", fonts);
  else Reflect.deleteProperty(document, "fonts");
});

async function advance(ms = 0) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}
function setFonts(ready: Promise<unknown>) {
  Object.defineProperty(document, "fonts", { configurable: true, value: { ready } });
}
function expectError(detail: string) {
  expect(screen.getByText("Diagram could not render")).toBeDefined();
  expect(screen.getByText(detail, { exact: false })).toBeDefined();
  expect(screen.getByRole("button", { name: "Copy code" })).toBeDefined();
  expect(screen.queryByText("Waiting for diagram…")).toBeNull();
  expect(screen.queryByText("Rendering diagram")).toBeNull();
}

/** Control only browser worker delivery; the real Markdown/Streamdown,
 * Pele engine, sanitizer, effects and cancellation remain in the workflow. */
class ControlledWorker extends EventTarget {
  static instances: ControlledWorker[] = [];
  request!: DiagramRequest;
  terminate = vi.fn();
  constructor() {
    super();
    ControlledWorker.instances.push(this);
  }
  postMessage(request: DiagramRequest) {
    this.request = request;
  }
  deliver(response: DiagramResponse = renderDiagram(this.request)) {
    // Deliberately allow delivery after termination to test stale callbacks.
    this.dispatchEvent(new MessageEvent("message", { data: response }));
  }
}
function controlWorkers() {
  ControlledWorker.instances = [];
  vi.stubGlobal("Worker", ControlledWorker);
  return ControlledWorker.instances;
}

describe("diagram render lifecycle through Markdown", () => {
  it("keeps active input waiting, bounds an idle stream, and recovers on input/completion", async () => {
    const workers = controlWorkers();
    const incomplete = source.slice(0, -4);
    using fixture = renderMarkdown(incomplete, { props: { streaming: true } });
    await advance(diagramStreamingIdleTimeoutMs - 1);
    expect(screen.getByText("Waiting for diagram…")).toBeDefined();
    await fixture.update(incomplete + "\nB --> C", { streaming: true });
    await advance(diagramStreamingIdleTimeoutMs - 1);
    expect(screen.getByText("Waiting for diagram…")).toBeDefined();
    await advance(1);
    expectError("Diagram input stopped updating.");
    expect(workers).toHaveLength(0);
    await fixture.update(incomplete + "\nB --> D", { streaming: true });
    expect(screen.getByText("Waiting for diagram…")).toBeDefined();
    await fixture.update(incomplete + "\nB --> D", { streaming: false });
    await act(async () => workers[0]!.deliver());
    expect(fixture.container.querySelector("svg.pele")).not.toBeNull();
    await advance(diagramStreamingIdleTimeoutMs);
    expect(screen.queryByText("Diagram could not render")).toBeNull();
  });

  it("bounds layout measurement and recovers when the container becomes measurable", async () => {
    measurement.resize(0);
    using fixture = renderMarkdown(source);
    await advance(diagramTimeoutMs);
    expectError("Diagram rendering exceeded five seconds.");
    await act(async () => measurement.resize(800));
    expect(fixture.container.querySelector("svg.pele")).not.toBeNull();
    expect(screen.queryByText("Diagram could not render")).toBeNull();
  });

  it("bounds font loading and ignores fonts resolving after the deadline", async () => {
    const workers = controlWorkers();
    const ready = Promise.withResolvers<void>();
    setFonts(ready.promise);
    using fixture = renderMarkdown(source);
    await advance(diagramTimeoutMs);
    expectError("Diagram rendering exceeded five seconds.");
    await act(async () => ready.resolve());
    expect(workers).toHaveLength(0);
    await fixture.update(source.replace("Player", "New player"));
    await act(async () => workers[0]!.deliver());
    expect(fixture.container.querySelector("svg.pele")?.textContent).toContain("New player");
  });

  it("shows rejected font loading as an error with the source available", async () => {
    const ready = Promise.withResolvers<void>();
    setFonts(ready.promise);
    using fixture = renderMarkdown(source);
    await act(async () => ready.reject(new Error("Font loading failed")));
    expectError("Font loading failed");
    expect(fixture.container.querySelector("pre")?.textContent).toContain("A[Player]");
  });

  it.each(["construction", "postMessage"])(
    "shows worker %s rejection instead of spinning",
    async (stage) => {
      vi.stubGlobal(
        "Worker",
        class extends EventTarget {
          constructor() {
            super();
            if (stage === "construction") throw new Error("Worker construction failed");
          }
          postMessage() {
            throw new Error("Worker postMessage failed");
          }
          terminate() {}
        },
      );
      using fixture = renderMarkdown(source);
      await advance();
      expectError(`Worker ${stage} failed`);
      expect(fixture.container.querySelector("pre")?.textContent).toContain("A[Player]");
    },
  );

  it("shows an actual parser failure as a terminal error", async () => {
    using fixture = renderMarkdown(source.replace("flowchart TB", "unsupportedDiagram"));
    await advance();
    expect(screen.getByRole("alert").textContent).toContain("Diagram could not render");
    expect(fixture.container.querySelector("svg.pele")).toBeNull();
    await advance(diagramTimeoutMs);
    expect(screen.getByRole("alert").textContent).toContain("Diagram could not render");
  });

  it.each(["error", "messageerror", "timeout", "invalid SVG", "syntax"])(
    "replaces rendering with a visible error on %s",
    async (failure) => {
      const workers = controlWorkers();
      using fixture = renderMarkdown(source);
      await advance();
      const worker = workers[0]!;
      await act(async () => {
        if (failure === "timeout") await vi.advanceTimersByTimeAsync(diagramTimeoutMs);
        else if (failure === "invalid SVG") worker.deliver({ svg: "not an SVG" });
        else if (failure === "syntax") worker.deliver({ error: "Unsupported diagram syntax" });
        else worker.dispatchEvent(new Event(failure));
      });
      expectError(
        failure === "error"
          ? "failed to load"
          : failure === "messageerror"
            ? "unreadable result"
            : failure === "timeout"
              ? "exceeded five seconds"
              : failure === "invalid SVG"
                ? "did not produce SVG"
                : "Unsupported diagram syntax",
      );
      expect(worker.terminate).toHaveBeenCalled();
      if (failure === "timeout") {
        await act(async () => worker.deliver());
        expectError("exceeded five seconds");
        expect(fixture.container.querySelector("svg.pele")).toBeNull();
      }
    },
  );

  it.each(["success", "error"])(
    "ignores obsolete worker %s after newer input renders",
    async (result) => {
      const workers = controlWorkers();
      using fixture = renderMarkdown(source);
      await advance();
      const obsolete = workers[0]!;
      await fixture.update(source.replace("Player", "Newest"));
      expect(obsolete.terminate).toHaveBeenCalled();
      await act(async () => workers[1]!.deliver());
      await act(async () => {
        if (result === "success") obsolete.deliver();
        else obsolete.dispatchEvent(new Event("error"));
      });
      expect(fixture.container.querySelector("svg.pele")?.textContent).toContain("Newest");
      expect(screen.queryByText("Diagram could not render")).toBeNull();
      await advance(diagramTimeoutMs);
      expect(fixture.container.querySelector("svg.pele")).not.toBeNull();
    },
  );
});
