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
