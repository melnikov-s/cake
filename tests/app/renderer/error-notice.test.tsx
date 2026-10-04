/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ErrorNotice } from "../../../src/renderer/components/error-notice";

describe("ErrorNotice", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("suppresses internal missing-session failures without hiding actionable session failures", () => {
    act(() => {
      root.render(
        <ErrorNotice
          title="Operation failed"
          message="Cake could not find Project Session 03bd332b-18f1-4e1f-bfa4-f92a1e9cab2a"
          details="Internal lookup stack\n\nContext:\nOpening Project Session"
        />,
      );
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe("");

    act(() => {
      root.render(
        <ErrorNotice
          title="Operation failed"
          message="Project Session ID collision detected: session-1"
        />,
      );
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Project Session ID collision detected: session-1",
    );
  });

  it("can be dismissed and shows a later error", () => {
    act(() => {
      root.render(<ErrorNotice title="Operation failed" message="First failure" />);
    });

    expect(container.textContent).toContain("First failure");
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss error"]')!.click();
    });
    expect(container.textContent).not.toContain("First failure");

    act(() => {
      root.render(<ErrorNotice title="Operation failed" message="Second failure" />);
    });
    expect(container.textContent).toContain("Second failure");
  });
});
