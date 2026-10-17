/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionTreeEntry } from "../../../src/contracts/conversations/session-contract";
import { SessionTree } from "../../../src/renderer/components/session-tree";

function node(id: string, parentId?: string): SessionTreeEntry {
  return { id, parentId, type: "message", messageRole: "user", preview: id, active: true };
}

// SessionTree consumes plain transcript-tree data and callbacks, not a Store.
afterEach(cleanup);

describe("SessionTree presentation", () => {
  it("keeps conversation chains flat and indents only genuine branch points", () => {
    const view = render(
      <SessionTree
        nodes={[node("one"), node("two", "one"), node("three", "two")]}
        onNavigate={() => {}}
        onFork={() => {}}
      />,
    );
    expect(screen.getAllByRole("treeitem").map((row) => row.getAttribute("aria-level"))).toEqual([
      "1",
      "1",
      "1",
    ]);
    view.rerender(
      <SessionTree
        nodes={[
          node("root"),
          node("left", "root"),
          node("left-next", "left"),
          node("right", "root"),
          node("right-next", "right"),
        ]}
        onNavigate={() => {}}
        onFork={() => {}}
      />,
    );
    expect(screen.getAllByRole("treeitem").map((row) => row.getAttribute("aria-level"))).toEqual([
      "1",
      "2",
      "2",
      "2",
      "2",
    ]);
    expect(screen.getAllByRole("treeitem").map((row) => row.textContent)).toEqual([
      "userrootFork",
      "userleftFork",
      "userleft-nextFork",
      "userrightFork",
      "userright-nextFork",
    ]);
  });

  it("omits metadata, tool results and empty responses without breaking visible ancestry or navigation", async () => {
    const actions: string[] = [];
    const user = userEvent.setup();
    render(
      <SessionTree
        nodes={[
          node("Question"),
          { ...node("model", "Question"), type: "model_change", preview: "provider/model" },
          { ...node("tool", "model"), messageRole: "toolResult", preview: "[read]" },
          { ...node("empty", "tool"), messageRole: "assistant", preview: "" },
          { ...node("thinking", "empty"), type: "thinking_level_change", preview: "high" },
          { ...node("answer", "thinking"), messageRole: "assistant", preview: "Response" },
        ]}
        onNavigate={(id) => actions.push(`navigate:${id}`)}
        onFork={(id) => actions.push(`fork:${id}`)}
      />,
    );
    const rows = screen.getAllByRole("treeitem");
    expect(rows.map((row) => row.getAttribute("aria-level"))).toEqual(["1", "1"]);
    expect(rows.map((row) => row.textContent)).toEqual([
      "userQuestionFork",
      "assistantResponseFork",
    ]);
    await user.click(screen.getByRole("button", { name: "assistant Response" }));
    await user.click(screen.getByRole("button", { name: "Fork from Response" }));
    expect(actions).toEqual(["navigate:answer", "fork:answer"]);
  });
});
