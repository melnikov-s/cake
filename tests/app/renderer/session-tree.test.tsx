/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionTreeNode } from "../../../src/ipc/session-contract";
import { flattenSessionTree, SessionTree, visibleSessionTree } from "../../../src/renderer/components/session-tree";

function node(id: string, children: SessionTreeNode[] = []): SessionTreeNode {
  return { id, type: "message", preview: id, active: true, children };
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
    const tree = [node("one", [node("two", [node("three")])])];

    expect(flattenSessionTree(tree).map(({ node: item, depth }) => [item.id, depth])).toEqual([
      ["one", 0], ["two", 0], ["three", 0]
    ]);
  });

  it("adds depth only after a real branch point", () => {
    const tree = [node("root", [node("left", [node("left-next")]), node("right", [node("right-next")])])];

    expect(flattenSessionTree(tree).map(({ node: item, depth }) => [item.id, depth])).toEqual([
      ["root", 0], ["left", 1], ["left-next", 1], ["right", 1], ["right-next", 1]
    ]);
  });

  it("shows only non-empty user and assistant messages", () => {
    const user = { ...node("user"), messageRole: "user", preview: "Hello" };
    const thinking = { ...node("thinking", [user]), type: "thinking_level_change", preview: "high" };
    const emptyAssistant = { ...node("empty", [thinking]), messageRole: "assistant", preview: "" };
    const tool = { ...node("tool", [emptyAssistant]), messageRole: "toolResult", preview: "[read]" };
    const rootNode = { ...node("model", [tool]), type: "model_change", preview: "provider/model" };

    expect(visibleSessionTree([rootNode]).map((item) => item.id)).toEqual(["user"]);
  });

  it("renders readable roles and omits tool results", () => {
    const assistant = { ...node("assistant"), messageRole: "assistant", preview: "Hello back" };
    const tool = { ...node("tool", [assistant]), messageRole: "toolResult", preview: "[read]" };
    act(() => root.render(<SessionTree nodes={[tool]} onNavigate={vi.fn()} onFork={vi.fn()} />));

    expect(container.querySelector(".session-tree-role")?.textContent).toBe("assistant");
    expect(container.querySelector('[role="treeitem"]')?.textContent).toContain("Hello back");
    expect(container.textContent).not.toContain("[read]");
  });

  it("keeps navigation and fork actions available on flattened rows", () => {
    const onNavigate = vi.fn();
    const onFork = vi.fn();
    const assistant = { ...node("two"), messageRole: "assistant", preview: "Response" };
    const user = { ...node("one", [assistant]), messageRole: "user", preview: "Question" };
    act(() => root.render(<SessionTree nodes={[user]} onNavigate={onNavigate} onFork={onFork} />));

    const rows = container.querySelectorAll('[role="treeitem"]');
    expect(rows).toHaveLength(2);
    act(() => rows[1]!.querySelector<HTMLButtonElement>("button")!.click());
    act(() => rows[1]!.querySelectorAll<HTMLButtonElement>("button")[1]!.click());
    expect(onNavigate).toHaveBeenCalledWith("two");
    expect(onFork).toHaveBeenCalledWith("two");
  });
});
