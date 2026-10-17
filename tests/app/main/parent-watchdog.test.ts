import { afterEach, expect, it, vi } from "vitest";
import { installParentProcessWatchdog } from "../../../src/main/parent-watchdog";

afterEach(() => {
  vi.useRealTimers();
});

it("reports orphaning once after the original parent dies", () => {
  vi.useFakeTimers();
  const process = { ppid: 4321 };
  const orphaned = vi.fn();
  installParentProcessWatchdog(process, orphaned, 100);
  vi.advanceTimersByTime(500);
  expect(orphaned).not.toHaveBeenCalled();
  process.ppid = 1;
  vi.advanceTimersByTime(100);
  vi.advanceTimersByTime(500);
  expect(orphaned).toHaveBeenCalledOnce();
});

it("reports immediately when the parent died before installation", () => {
  const orphaned = vi.fn();
  installParentProcessWatchdog({ ppid: 1 }, orphaned);
  expect(orphaned).toHaveBeenCalledOnce();
});

it("stops watching when disposed", () => {
  vi.useFakeTimers();
  const process = { ppid: 4321 };
  const orphaned = vi.fn();
  const dispose = installParentProcessWatchdog(process, orphaned, 100);
  dispose();
  process.ppid = 1;
  vi.advanceTimersByTime(500);
  expect(orphaned).not.toHaveBeenCalled();
});
