/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installStaleAssetRecovery } from "../../../src/renderer/lib/stale-asset-recovery";

describe("stale asset recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reloads once when a generated chunk is no longer available", () => {
    const reload = vi.fn();
    const dispose = installStaleAssetRecovery(reload);
    const firstError = new Event("vite:preloadError", { cancelable: true });
    const repeatedError = new Event("vite:preloadError", { cancelable: true });

    window.dispatchEvent(firstError);
    window.dispatchEvent(repeatedError);

    expect(firstError.defaultPrevented).toBe(true);
    expect(repeatedError.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledOnce();
    dispose();
  });

  it("allows another recovery after the guard window", () => {
    const reload = vi.fn();
    const dispose = installStaleAssetRecovery(reload);

    window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
    vi.advanceTimersByTime(10_000);
    window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));

    expect(reload).toHaveBeenCalledTimes(2);
    dispose();
  });
});
