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

  it("shortens only display paths while retaining navigation, copy and details", async () => {
    const onOpenSourceLocation = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const path = "/home/alex/outside/file.ts";
    act(() => {
      root.render(
        <Tool
          part={{
            id: "read-home",
            kind: "tool",
            name: "read",
            input: JSON.stringify({ path }),
            output: "contents",
            state: "success",
          }}
          homeDirectory="/home/alex"
          workspacePath="/home/alex/project"
          onOpenSourceLocation={onOpenSourceLocation}
        />,
      );
    });
    const pathButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "~/outside/file.ts",
    )!;
    expect(pathButton.title).toBe(path);
    act(() => pathButton.click());
    expect(onOpenSourceLocation).toHaveBeenCalledWith({ path });
    const disclosure = container.querySelector<HTMLButtonElement>("[aria-expanded]")!;
    act(() => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-slot=tool-details]")?.hasAttribute("hidden")).toBe(false);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[aria-label="Copy ${path}"]`)!.click();
    });
    expect(writeText).toHaveBeenCalledWith(path);
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
