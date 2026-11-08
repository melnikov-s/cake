import { describe, expect, it } from "vitest";
import { makeLandingPhaseRecorder } from "../../../../src/services/diagnostics/landing-phase-diagnostics";
import type { WorktreeLandingOperation } from "../../../../src/contracts/worktrees/worktree-landing-data";

const operation = (phase: WorktreeLandingOperation["phase"]): WorktreeLandingOperation => ({
  operationId: "landing-1",
  sessionId: "private-session",
  workspacePath: "/private/path",
  phase,
  kind: "landing",
  allowDirtyTarget: false,
});
const state = (phase: WorktreeLandingOperation["phase"]) =>
  new Map([["/private/path", operation(phase)]]);

describe("landing phase diagnostics", () => {
  it("measures conflict-owner wait, retry and completion without duplicate snapshots or user content", () => {
    const record = makeLandingPhaseRecorder();
    expect(record(state("waiting"), 100)).toMatchObject([{ phase: "waiting" }]);
    expect(record(state("landing"), 150)).toMatchObject([
      { previousPhase: "waiting", phase: "landing", durationMs: 50, totalDurationMs: 50 },
    ]);
    expect(record(state("resolving"), 200)).toMatchObject([
      { previousPhase: "landing", durationMs: 50 },
    ]);
    expect(record(state("resolving"), 250)).toEqual([]);
    expect(record(state("stalled"), 1200)).toMatchObject([
      { previousPhase: "resolving", durationMs: 1000 },
    ]);
    expect(record(state("landing"), 2200)).toMatchObject([
      { previousPhase: "stalled", durationMs: 1000 },
    ]);
    const completed = record(state("landed"), 2300);
    expect(completed).toMatchObject([{ phase: "landed", durationMs: 100, totalDurationMs: 2200 }]);
    expect(JSON.stringify(completed)).not.toMatch(/private-session|private\/path|landing-1/);
    expect(record(new Map(), 2400)).toEqual([]);
  });
  it("distinguishes cancellation from failed completion and does not call acknowledgment a cancellation", () => {
    const record = makeLandingPhaseRecorder();
    record(state("queued"), 0);
    expect(record(new Map(), 400)).toMatchObject([
      { phase: "canceled", previousPhase: "queued", durationMs: 400 },
    ]);
    record(state("landing"), 500);
    const failed = new Map([
      ["/private/path", { ...operation("failed"), error: "secret Git body" }],
    ]);
    const events = record(failed, 700);
    expect(events).toMatchObject([
      { phase: "failed", previousPhase: "landing", durationMs: 200, error: expect.any(String) },
    ]);
    expect(JSON.stringify(events)).not.toContain("secret Git body");
    expect(record(new Map(), 800)).toEqual([]);
  });
});
