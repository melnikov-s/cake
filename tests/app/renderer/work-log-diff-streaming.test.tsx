/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../src/ipc/session-contract";
import { WorkLogDiff } from "../../../src/renderer/components/ai-elements/work-log-diff";

function editPart(diff: string, inputStreaming = true): Extract<UiPart, { kind: "tool" }> {
  return {
    id: "streaming-edit",
    kind: "tool",
    name: "edit",
    input: "",
    filePath: "src/app.ts",
    diff,
    inputStreaming,
    state: inputStreaming ? "running" : "success",
  };
}

describe("streaming work-log diff buffering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.useRealTimers();
    container.remove();
  });

  function render(part: Extract<UiPart, { kind: "tool" }>) {
    act(() => root.render(<WorkLogDiff parts={[part]} streaming={part.state === "running"} />));
  }

  it("coalesces token updates but publishes lines, larger chunks, and completion promptly", () => {
    render(editPart("+const value ="));

    render(editPart("+const value = 1"));
    expect(container.textContent).not.toContain("value = 1");

    act(() => vi.advanceTimersByTime(119));
    expect(container.textContent).not.toContain("value = 1");
    act(() => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain("value = 1");

    render(editPart("+const value = 12"));
    expect(container.textContent).not.toContain("value = 12");
    render(editPart("+const value = 12\n+const next = 2"));
    expect(container.textContent).toContain("const next = 2");

    const largeSuffix = "x".repeat(200);
    render(editPart(`+const value = 12\n+const next = 2${largeSuffix}`));
    expect(container.textContent).toContain(largeSuffix);

    render(editPart("+const settled = true", false));
    expect(container.textContent).toContain("const settled = true");
    expect(container.querySelector('[aria-label="File changes to src/app.ts"]')).not.toBeNull();
  });
});
