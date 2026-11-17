/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTooltip } from "../../../src/renderer/components/ui/tooltip";

let target: HTMLButtonElement;
beforeEach(() => {
  vi.useFakeTimers();
  target = document.createElement("button");
  document.body.append(target);
});
afterEach(() => {
  cleanup();
  target.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const dismissals = [
  ["ancestor scroll", () => document.body.dispatchEvent(new Event("scroll"))],
  ["window resize", () => window.dispatchEvent(new Event("resize"))],
  ["window blur", () => window.dispatchEvent(new Event("blur"))],
  ["Escape", () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))],
] as const;

for (const [name, dismiss] of dismissals) {
  it.each([false, true])(`dismisses ${name} while visible=%s without resurrection`, (visible) => {
    const hook = renderHook(() => useTooltip());
    act(() => hook.result.current.show(target));
    if (visible) {
      act(() => vi.advanceTimersByTime(120));
      expect(hook.result.current.anchor).toBe(target);
    }
    act(dismiss);
    expect(hook.result.current.anchor).toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(hook.result.current.anchor).toBeNull();
    // Dismissal does not disable legitimate subsequent hover/focus reveals.
    act(() => hook.result.current.show(target));
    act(() => vi.advanceTimersByTime(120));
    expect(hook.result.current.anchor).toBe(target);
  });
}

it.each([false, true])(
  "dismisses removed anchors while visible=%s even when the hook survives",
  async (visible) => {
    const hook = renderHook(() => useTooltip());
    act(() => hook.result.current.show(target));
    if (visible) act(() => vi.advanceTimersByTime(120));
    await act(async () => {
      target.remove();
      await Promise.resolve();
    });
    expect(hook.result.current.anchor).toBeNull();
    act(() => vi.advanceTimersByTime(500));
    expect(hook.result.current.anchor).toBeNull();
  },
);

it("replaces a pending target without retaining the old target's timer or observer", async () => {
  const hook = renderHook(() => useTooltip());
  const replacement = document.createElement("button");
  document.body.append(replacement);
  try {
    act(() => hook.result.current.show(target));
    act(() => vi.advanceTimersByTime(60));
    act(() => hook.result.current.show(replacement));
    await act(async () => {
      target.remove();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(60));
    expect(hook.result.current.anchor).toBeNull();
    act(() => vi.advanceTimersByTime(60));
    expect(hook.result.current.anchor).toBe(replacement);
  } finally {
    replacement.remove();
  }
});

it("cancels pending work and releases active listeners on disable and unmount", () => {
  const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
  const remove = vi.spyOn(window, "removeEventListener");
  const hook = renderHook(({ enabled }) => useTooltip(enabled), {
    initialProps: { enabled: true },
  });
  act(() => hook.result.current.show(target));
  hook.rerender({ enabled: false });
  act(() => vi.advanceTimersByTime(120));
  expect(hook.result.current.anchor).toBeNull();
  expect(disconnect).toHaveBeenCalledTimes(1);
  hook.rerender({ enabled: true });
  act(() => hook.result.current.show(target));
  hook.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(disconnect).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function), true);
  expect(remove).toHaveBeenCalledWith("blur", expect.any(Function));
});
