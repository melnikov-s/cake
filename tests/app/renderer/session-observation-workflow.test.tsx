/** @vitest-environment jsdom */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSessionObservation } from "./session-observation-workflow-fixture";

beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  // Native geometry/focus are not asserted by these navigation/resource contracts.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 24, height: 24 }),
  });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(SVGElement.prototype, "getBBox");
  vi.unstubAllGlobals();
});

// Observation demand is a resource contract, not visible text. Drive real App navigation,
// then inspect Root's production synchronization output alongside the rendered panes.
// Actual Stream acquisition/cancellation remains the Model observer integration's concern.
describe("Session observation navigation integration", () => {
  it("resets restored warm observations, pins the selected pane and observes a deliberately opened archive", async () => {
    using fixture = renderSessionObservation({ restored: true });
    expect(screen.getByRole("combobox", { name: "Message" })).toBeDefined();
    expect(fixture.demand()).toEqual([
      { sessionId: "selected", workingDirectory: "/project", allowCreate: false },
    ]);

    await fixture.user.click(screen.getByRole("button", { name: /^Task idle-0 / }));
    await waitFor(() => expect(fixture.opened).toContain("idle-0"));
    expect(fixture.demand().map(({ sessionId }) => sessionId)).toEqual(["selected", "idle-0"]);

    await fixture.user.click(screen.getByRole("button", { name: "Expand Resolved" }));
    await fixture.user.click(
      screen.getAllByRole("button", { name: "Expand Project resolved" })[0]!,
    );
    await fixture.user.click(screen.getByRole("button", { name: /^Archived task / }));
    await waitFor(() => expect(fixture.opened).toContain("archive"));
    expect(fixture.demand()).toContainEqual({
      sessionId: "archive",
      workingDirectory: "/project",
      allowCreate: false,
    });
    expect(screen.getByRole("button", { name: "Restore Archived task" })).toBeDefined();
  });

  it("keeps the visible pane and running session outside the idle budget while navigating, then trims after completion", async () => {
    using fixture = renderSessionObservation({ split: true });
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(2);
    for (let index = 0; index < 6; index += 1) {
      await fixture.user.click(
        screen.getByRole("button", { name: new RegExp(`^Task idle-${index} `) }),
      );
      await waitFor(() => expect(fixture.opened).toContain(`idle-${index}`));
    }
    expect(
      fixture
        .demand()
        .map(({ sessionId }) => sessionId)
        .sort(),
    ).toEqual(["idle-1", "idle-2", "idle-3", "idle-4", "idle-5", "running", "visible"]);
    expect(fixture.demand().every(({ allowCreate }) => !allowCreate)).toBe(true);
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(2);

    fixture.settleRunning();
    expect(
      fixture
        .demand()
        .map(({ sessionId }) => sessionId)
        .sort(),
    ).toEqual(["idle-2", "idle-3", "idle-4", "idle-5", "running", "visible"]);
    expect(screen.getAllByRole("combobox", { name: "Message" })).toHaveLength(2);
  });
});
