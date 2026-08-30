/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Tool } from "../../../../../src/renderer/components/ai-elements/tool";

describe("Tool", () => {
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

  it("opens a file from its name and keeps elapsed time at the far right", () => {
    const onOpenSourceLocation = vi.fn();
    act(() => {
      root.render(
        <Tool
          part={{
            id: "read-1",
            kind: "tool",
            name: "read",
            input: JSON.stringify({ path: "src/app.ts" }),
            output: "contents",
            state: "success",
          }}
          onOpenSourceLocation={onOpenSourceLocation}
          timer={<span className="tool-timer">1.2s</span>}
        />,
      );
    });

    expect(container.querySelector('button[aria-label="Copy src/app.ts"]')).not.toBeNull();
    const pathButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "src/app.ts",
    )!;
    act(() => pathButton.click());
    expect(onOpenSourceLocation).toHaveBeenCalledWith({ path: "src/app.ts" });
    expect(container.querySelector(".tool-timer")).not.toBeNull();
  });

  it("opens an edit at the changed range reported by the tool", () => {
    const onOpenSourceLocation = vi.fn();
    act(() => {
      root.render(
        <Tool
          part={{
            id: "edit-1",
            kind: "tool",
            name: "edit",
            input: JSON.stringify({ path: "src/app.ts" }),
            diff: "@@ -8 +8,2 @@\n-old\n+new\n+next",
            state: "success",
          }}
          onOpenSourceLocation={onOpenSourceLocation}
        />,
      );
    });

    const pathButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "src/app.ts",
    )!;
    act(() => pathButton.click());
    expect(onOpenSourceLocation).toHaveBeenCalledWith({
      path: "src/app.ts",
      range: { start: { line: 7 }, end: { line: 8 } },
    });
  });
});
