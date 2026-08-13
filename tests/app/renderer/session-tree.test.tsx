/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeEntry } from "../../../src/ipc/session-contract";
import { flattenSessionTree, SessionTree, visibleSessionTree } from "../../../src/renderer/components/session-tree";

function node(id: string, parentId?: string): SessionTreeEntry {
  return { id, parentId, type: "message", preview: id, active: true };
}

describe("SessionTree", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("keeps a normal single-child conversation flat", () => {
    const tree = [node("one"), node("two", "one"), node("three", "two")];

    expect(flattenSessionTree(tree).map(({ node: item, depth }) => [item.id, depth])).toEqual([
      ["one", 0], ["two", 0], ["three", 0]
    ]);
  });

  it("adds depth only after a real branch point", () => {
    const tree = [node("root"), node("left", "root"), node("left-next", "left"), node("right", "root"), node("right-next", "right")];

    expect(flattenSessionTree(tree).map(({ node: item, depth }) => [item.id, depth])).toEqual([
      ["root", 0], ["left", 1], ["left-next", 1], ["right", 1], ["right-next", 1]
    ]);
  });

  it("shows only non-empty user and assistant messages", () => {
    const rootNode = { ...node("model"), type: "model_change", preview: "provider/model" };
    const tool = { ...node("tool", "model"), messageRole: "toolResult", preview: "[read]" };
    const emptyAssistant = { ...node("empty", "tool"), messageRole: "assistant", preview: "" };
    const thinking = { ...node("thinking", "empty"), type: "thinking_level_change", preview: "high" };
    const user = { ...node("user", "thinking"), messageRole: "user", preview: "Hello" };

    expect(visibleSessionTree([rootNode, tool, emptyAssistant, thinking, user])).toEqual([
      expect.objectContaining({ id: "user", parentId: undefined })
    ]);
  });

  it("renders readable roles and omits tool results", () => {
    const tool = { ...node("tool"), messageRole: "toolResult", preview: "[read]" };
    const assistant = { ...node("assistant", "tool"), messageRole: "assistant", preview: "Hello back" };
    act(() => root.render(<SessionTree nodes={[tool, assistant]} onNavigate={vi.fn()} onFork={vi.fn()} />));

    expect(container.querySelector(".session-tree-role")?.textContent).toBe("assistant");
    expect(container.querySelector('[role="treeitem"]')?.textContent).toContain("Hello back");
    expect(container.textContent).not.toContain("[read]");
  });

  it("keeps navigation and fork actions available on flattened rows", () => {
    const onNavigate = vi.fn();
    const onFork = vi.fn();
    const user = { ...node("one"), messageRole: "user", preview: "Question" };
    const assistant = { ...node("two", "one"), messageRole: "assistant", preview: "Response" };
    act(() => root.render(<SessionTree nodes={[user, assistant]} onNavigate={onNavigate} onFork={onFork} />));

    const rows = container.querySelectorAll('[role="treeitem"]');
    expect(rows).toHaveLength(2);
    act(() => rows[1]!.querySelector<HTMLButtonElement>("button")!.click());
    act(() => rows[1]!.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
    expect(onNavigate).toHaveBeenCalledWith("two");
    expect(onFork).toHaveBeenCalledWith("two");
  });
});
