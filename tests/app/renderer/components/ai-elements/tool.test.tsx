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
          timer={<span className="tool-timer">1s</span>}
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
    expect(pathButton.className).toContain("select-text");
    act(() => pathButton.click());
    expect(onOpenSourceLocation).toHaveBeenCalledWith({ path });
    const disclosure = container.querySelector<HTMLButtonElement>("[aria-expanded]")!;
    expect(disclosure.className).toContain("select-text");
    act(() => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector("[data-slot=tool-details]")?.hasAttribute("hidden")).toBe(false);
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[aria-label="Copy ${path}"]`)!.click();
    });
    expect(writeText).toHaveBeenCalledWith(path);
  });

  it.each([0, 5, 49, 50, 100, 999, 1000, 1200])(
    "shows nested duration %sms in whole seconds, omitting zero",
    (durationMs) => {
      const call = {
        id: "nested",
        name: "read",
        input: '{"path":"a.ts"}',
        state: "success" as const,
        durationMs,
        outputAvailability: "unavailable" as const,
      };
      act(() => root.render(<Tool part={{ kind: "tool", ...call }} activity={call} />));
      const elapsed = container.querySelector('[aria-label="elapsed time"]');
      if (durationMs < 1000) expect(elapsed).toBeNull();
      else expect(elapsed?.textContent).toBe("1s");
    },
  );

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
