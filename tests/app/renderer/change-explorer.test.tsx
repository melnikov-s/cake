/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChange } from "../../../src/ipc/session-contract";
import type { WindowStore } from "../../../src/renderer/stores/window-store";

vi.mock("@streamdown/code", () => ({
  code: {
    getThemes: () => ["github-light", "github-dark"],
    highlight: ({ code }: { code: string }, callback: (result: unknown) => void) => {
      const result = { tokens: code.split("\n").map((line) => [{ content: line, htmlStyle: { color: "#123456", "--shiki-dark": "#abcdef" } }]) };
      callback(result);
      return result;
    }
  }
}));

import { ChangeExplorer } from "../../../src/renderer/components/change-explorer";

const changes: SessionChange[] = [
  { id: "file:src/app.ts", toolCallId: "call-1", path: "src/app.ts", additions: 1, deletions: 1, diff: "-1 const old = true;\n+1 const fresh = true;", timestamp: new Date(0).toISOString() },
  { id: "file:PLAN.md", toolCallId: "call-2", path: "PLAN.md", additions: 1, deletions: 0, diff: "+1 # Plan", timestamp: new Date(0).toISOString() }
];

describe("ChangeExplorer", () => {
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

  it("fills the app with a highlighted diff and a selectable file tree", () => {
    const store = {
      sessionChanges: changes,
      selectedSessionChange: changes[0],
      sessionTitle: "Refine the plan",
      selectChangeExplorerFile: vi.fn(),
      closeChangeExplorer: vi.fn()
    } as unknown as WindowStore;

    act(() => root.render(<ChangeExplorer store={store} />));

    expect(container.querySelector(".change-explorer")).not.toBeNull();
    expect(container.querySelector(".change-explorer-file header")?.textContent).toContain("Refine the plan");
    expect(container.querySelector(".syntax-token")?.textContent).toContain("const old");
    expect(container.querySelector(".change-explorer-tree")?.textContent).toContain("src");
    expect(container.querySelector(".change-explorer-tree")?.textContent).toContain("PLAN.md");
    act(() => container.querySelector<HTMLButtonElement>(".change-explorer-tree li button")!.click());
    expect(store.selectChangeExplorerFile).toHaveBeenCalledWith("src/app.ts");
  });
});
