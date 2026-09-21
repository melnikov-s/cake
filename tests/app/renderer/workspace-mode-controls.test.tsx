/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceModeControls } from "../../../src/renderer/components/workspace-mode-controls";
import type { ChatStore } from "../../../src/renderer/stores/ChatStore";

const chat = {
  workLogPresentation: {
    viewMode: "auto",
    expansion: "collapsed",
    setViewMode: vi.fn(),
    setExpansion: vi.fn(),
  },
} as unknown as ChatStore;

const callbacks = {
  onToggleTree: vi.fn(),
  onBackToAgent: vi.fn(),
  onOpenDraw: vi.fn(),
  onOpenBrowser: vi.fn(),
  onOpenIde: vi.fn(),
  onToggleTerminal: vi.fn(),
};

describe("WorkspaceModeControls", () => {
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
    vi.clearAllMocks();
  });

  function render(mode: "draw" | "browser" | "vscode") {
    act(() =>
      root.render(
        <WorkspaceModeControls
          mode={mode}
          chat={chat}
          treeOpen={false}
          terminalAvailable
          terminalOpen={false}
          terminalAcceleratorHint="⌘J"
          {...callbacks}
        />,
      ),
    );
    return [...container.querySelectorAll<HTMLButtonElement>("button")].map((button) =>
      button.getAttribute("aria-label"),
    );
  }

  it.each([
    ["draw", ["Back to agent", "Open Browser Mode", "Open VS Code"]],
    ["browser", ["Open Cake Draw", "Back to agent", "Open VS Code"]],
    ["vscode", ["Open Cake Draw", "Open Browser Mode", "Back to agent"]],
  ] as const)("replaces the active %s mode with the Agent action", (mode, expectedModes) => {
    const labels = render(mode);

    expect(labels).toEqual([
      "Session tree",
      "Work log display options",
      ...expectedModes,
      "Terminal (⌘J)",
    ]);
  });

  it("routes the Cake icon back to the Agent", () => {
    render("browser");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Back to agent"]')!.click());

    expect(callbacks.onBackToAgent).toHaveBeenCalledOnce();
  });
});
