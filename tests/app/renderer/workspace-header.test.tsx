/** @vitest-environment jsdom */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  ShellHeaderContext,
  WorkspaceHeader,
} from "../../../src/renderer/components/ui/workspace-header";
import { WorkspaceModeControls } from "../../../src/renderer/components/workspace-mode-controls";

afterEach(cleanup);

it.each([
  { browserHost: false, ideAvailable: true, names: ["Main", "VS Code", "Browser"] },
  { browserHost: true, ideAvailable: true, names: ["Main", "VS Code"] },
  { browserHost: false, ideAvailable: false, names: ["Main", "Browser"] },
])("centers only available modes: $names", ({ browserHost, ideAvailable, names }) => {
  render(
    <WorkspaceHeader title="Conversation">
      <button>Artifacts</button>
      <WorkspaceModeControls
        mode="normal"
        browserHost={browserHost}
        ideAvailable={ideAvailable}
        terminalAvailable={false}
        terminalOpen={false}
        onBackToAgent={vi.fn()}
        onOpenBrowser={vi.fn()}
        onOpenIde={vi.fn()}
        onToggleTerminal={vi.fn()}
      />
      <button>Work log</button>
    </WorkspaceHeader>,
  );
  const modes = screen.getByRole("group", { name: "Conversation workspace" });
  expect(
    within(modes)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label")),
  ).toEqual(names);
  expect(modes.parentElement?.getAttribute("data-slot")).toBe("workspace-mode");
  const actions = document.querySelector('[data-slot="workspace-actions"]')!;
  expect(
    within(actions as HTMLElement)
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["Artifacts", "Terminal", "Work log"]);
  expect(screen.getByRole("button", { name: "Terminal" }).hasAttribute("disabled")).toBe(true);
});

it("keeps the compact drop-down title and actions inline without a mode slot", () => {
  render(
    <WorkspaceHeader compact title="Cake Chat" titleLeading={<button>Destination</button>}>
      <button>Close</button>
    </WorkspaceHeader>,
  );
  const header = screen.getByRole("banner");
  expect(header.querySelector('[data-slot="workspace-mode"]')).toBeNull();
  expect(header.classList.contains("flex")).toBe(true);
  expect(
    within(header)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Destination", "Close"]);
});

it("centers the shell header's mode group on the window, not between title and actions", () => {
  const target = document.createElement("div");
  document.body.append(target);
  try {
    render(
      <ShellHeaderContext value={target}>
        <WorkspaceHeader title="Conversation">
          <button>Artifacts</button>
        </WorkspaceHeader>
      </ShellHeaderContext>,
    );
    const header = target.querySelector('[data-slot="workspace-header"]')!;
    // The first track ends at the window's center line; the mode group overflows a
    // zero-width track there evenly, so VS Code (the middle mode) sits under the notch.
    expect(header.className).toContain(
      "grid-cols-[minmax(0,calc(50vw-var(--project-rail-width,0px)-var(--workspace-header-start)))_0px_minmax(0,1fr)]",
    );
    expect(header.querySelector('[data-slot="workspace-mode"]')!.className).toContain(
      "justify-center",
    );
  } finally {
    target.remove();
  }
});
