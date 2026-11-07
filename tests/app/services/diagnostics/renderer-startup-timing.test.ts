import { expect, it, vi } from "vitest";
import { STARTUP_TIMING_PREFIX } from "../../../../src/contracts/desktop/startup-timing";
import { makeRendererStartupReceiver } from "../../../../src/services/diagnostics/renderer-startup-timing";
import { makeRendererStartupTiming } from "../../../../src/renderer/lib/startup-timing";

it("emits each renderer phase once and retains only bounded allowlisted timing fields", () => {
  const report = vi.fn();
  const receiver = makeRendererStartupReceiver(report);
  const mark = vi.fn();
  const emit = vi.fn(receiver);
  const timing = makeRendererStartupTiming(() => 42, emit, mark);
  timing("first-commit");
  timing("first-commit");
  timing("selected-chat-projection-commit");
  expect(report.mock.calls).toEqual([
    [{ phase: "first-commit", rendererElapsedMs: 42 }],
    [{ phase: "selected-chat-projection-commit", rendererElapsedMs: 42 }],
  ]);
  expect(mark).toHaveBeenCalledTimes(2);
  receiver(
    STARTUP_TIMING_PREFIX +
      JSON.stringify({ phase: "render-scheduled", rendererElapsedMs: 50, transcript: "PRIVATE" }),
  );
  expect(report).toHaveBeenLastCalledWith({ phase: "render-scheduled", rendererElapsedMs: 50 });
});

it("ignores malformed, oversized, arbitrary and invalid timing messages", () => {
  const report = vi.fn();
  const receive = makeRendererStartupReceiver(report);
  for (const message of [
    "ordinary renderer console output",
    STARTUP_TIMING_PREFIX + "{",
    STARTUP_TIMING_PREFIX + "x".repeat(300),
    STARTUP_TIMING_PREFIX + JSON.stringify({ phase: "transcript", rendererElapsedMs: 1 }),
    STARTUP_TIMING_PREFIX + JSON.stringify({ phase: "first-commit", rendererElapsedMs: -1 }),
    STARTUP_TIMING_PREFIX + JSON.stringify({ phase: "first-commit", rendererElapsedMs: null }),
  ])
    receive(message);
  expect(report).not.toHaveBeenCalled();
});
