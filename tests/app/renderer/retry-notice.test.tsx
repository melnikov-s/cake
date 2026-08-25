/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryNotice } from "../../../src/renderer/components/retry-notice";

const start = new Date("2025-01-01T12:00:00.000Z");

describe("RetryNotice", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    vi.setSystemTime(start);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("counts down to the retry deadline", () => {
    act(() =>
      root.render(
        <RetryNotice
          part={{
            id: "active-retry",
            kind: "notice",
            tone: "warning",
            title: "Retry 1/3",
            detail: "Provider returned error",
            retryAt: start.getTime() + 2_000,
          }}
        />,
      ),
    );

    expect(container.textContent).toContain("Next retry in 2 seconds");

    act(() => vi.advanceTimersByTime(1_000));

    expect(container.textContent).toContain("Next retry in 1 second");
  });
});
