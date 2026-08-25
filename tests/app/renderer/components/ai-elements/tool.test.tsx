/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Tool } from "../../../../../src/renderer/components/ai-elements/tool";

describe("Tool", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("shows file actions on the path and keeps elapsed time at the far right", () => {
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
          onOpenFile={() => undefined}
          timer={<span className="tool-timer">1.2s</span>}
        />,
      );
    });

    expect(container.querySelector('button[aria-label="Copy src/app.ts"]')).not.toBeNull();
    const row = container.querySelector(".tool-summary-row")!;
    expect(row.lastElementChild?.classList.contains("tool-timer")).toBe(true);
    expect(
      row.children.item(row.children.length - 2)?.classList.contains("tool-editor-button"),
    ).toBe(true);
  });
});
