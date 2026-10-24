/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatElapsed,
  formatVisibleElapsed,
  LoadingState,
} from "../../../src/renderer/components/ui/loading-state";

describe("elapsed duration formatting", () => {
  it.each([
    [-100, "0s"],
    [0, "0s"],
    [1, "0s"],
    [499, "0s"],
    [999, "0s"],
    [1000, "1s"],
    [1599, "1s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [60_999, "1m 0s"],
    [435_400, "7m 15s"],
    [3_599_999, "59m 59s"],
    [3_600_000, "60m 0s"],
    [3_661_999, "61m 1s"],
  ])("formats %sms without overstating elapsed time", (milliseconds, expected) => {
    expect(formatElapsed(milliseconds)).toBe(expected);
    expect(formatVisibleElapsed(milliseconds)).toBe(expected === "0s" ? undefined : expected);
  });

  it("omits missing work-log timing", () => {
    expect(formatVisibleElapsed(undefined)).toBeUndefined();
  });
});

describe("LoadingState", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T12:00:00Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("shows a live elapsed timer until it unmounts", () => {
    act(() => root.render(<LoadingState label="Thinking" variant="Orbit" />));
    expect(container.textContent).toBe("Thinking0s");
    expect(container.querySelectorAll('[data-slot="loading-state-cell"]')).toHaveLength(9);

    act(() => vi.advanceTimersByTime(900));
    expect(container.textContent).toBe("Thinking0s");
    act(() => vi.advanceTimersByTime(100));
    expect(container.textContent).toBe("Thinking1s");
    act(() => vi.advanceTimersByTime(300));
    expect(container.textContent).toBe("Thinking1s");

    act(() => root.render(<div>Complete</div>));
    expect(container.querySelector('[data-slot="loading-state"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("continues from a supplied start time after remounting", () => {
    const startedAt = Date.now();
    act(() => root.render(<LoadingState startedAt={startedAt} />));
    act(() => vi.advanceTimersByTime(1_300));
    expect(container.textContent).toBe("Churning1s");

    act(() => root.render(<div>Another session</div>));
    act(() => vi.advanceTimersByTime(700));
    act(() => root.render(<LoadingState startedAt={startedAt} />));

    expect(container.textContent).toBe("Churning2s");
  });
});
