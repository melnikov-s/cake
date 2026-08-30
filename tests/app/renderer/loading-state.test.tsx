/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoadingState } from "../../../src/renderer/components/ui/loading-state";

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
    expect(container.textContent).toBe("Thinking0.0s");
    expect(container.querySelectorAll('[data-slot="loading-state-cell"]')).toHaveLength(9);

    act(() => vi.advanceTimersByTime(1_300));
    expect(container.textContent).toBe("Thinking1.3s");

    act(() => root.render(<div>Complete</div>));
    expect(container.querySelector('[data-slot="loading-state"]')).toBeNull();
  });

  it("continues from a supplied start time after remounting", () => {
    const startedAt = Date.now();
    act(() => root.render(<LoadingState startedAt={startedAt} />));
    act(() => vi.advanceTimersByTime(1_300));
    expect(container.textContent).toBe("Churning1.3s");

    act(() => root.render(<div>Another session</div>));
    act(() => vi.advanceTimersByTime(700));
    act(() => root.render(<LoadingState startedAt={startedAt} />));

    expect(container.textContent).toBe("Churning2.0s");
  });
});
