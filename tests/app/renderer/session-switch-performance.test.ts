import { afterEach, describe, expect, it } from "vitest";
import { beginSessionSwitchMeasurement } from "../../../src/renderer/lib/session-switch-performance";

afterEach(() => {
  performance.clearMarks("cake.session-switch.enabled");
  performance.clearMarks("cake.session-switch");
});

describe("session switch measurements", () => {
  it("records nothing without explicit opt-in", () => {
    const phase = beginSessionSwitchMeasurement("target", 1, "navigation");
    phase("selected");
    phase("finished");
    expect(performance.getEntriesByName("cake.session-switch")).toEqual([]);
  });

  it("correlates overlapping entries and distinguishes project opens from navigation", () => {
    performance.mark("cake.session-switch.enabled");
    const first = beginSessionSwitchMeasurement("target", 1, "navigation");
    const second = beginSessionSwitchMeasurement("target", 2, "project-open");
    first("superseded");
    second("selected");
    second("finished");
    const marks = performance.getEntriesByName("cake.session-switch") as PerformanceMark[];
    expect(marks.map((mark) => mark.detail)).toEqual([
      {
        sessionId: "target",
        revision: 1,
        source: "navigation",
        phase: "start",
        elapsedMs: expect.any(Number),
      },
      {
        sessionId: "target",
        revision: 2,
        source: "project-open",
        phase: "start",
        elapsedMs: expect.any(Number),
      },
      {
        sessionId: "target",
        revision: 1,
        source: "navigation",
        phase: "superseded",
        elapsedMs: expect.any(Number),
      },
      {
        sessionId: "target",
        revision: 2,
        source: "project-open",
        phase: "selected",
        elapsedMs: expect.any(Number),
      },
      {
        sessionId: "target",
        revision: 2,
        source: "project-open",
        phase: "finished",
        elapsedMs: expect.any(Number),
      },
    ]);
    expect(marks.every((mark) => mark.detail.elapsedMs >= 0)).toBe(true);
  });
});
