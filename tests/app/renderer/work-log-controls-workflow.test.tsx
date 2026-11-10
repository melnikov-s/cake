/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toSnapshot, type StoreSnapshot } from "r-state-tree";
import { StoreProvider } from "r-state-tree/react";
import { afterEach, expect, it } from "vitest";
import { CAKE_CHAT_SESSION_ID } from "../../../src/contracts/cake-chats/cake-chat-identity";
import { CakeChatPaneHeader } from "../../../src/renderer/components/cake-chat-pane-header";
import { CakeChatWorkspaceControls } from "../../../src/renderer/components/cake-chat-workspace-controls";
import { ProjectPaneHeader } from "../../../src/renderer/components/project-pane-header";
import { ProjectWorkspaceControls } from "../../../src/renderer/components/project-workspace-controls";
import { SETTINGS_NAV_GROUPS } from "../../../src/renderer/lib/settings-search";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";
import { createRendererStoreFixture } from "./renderer-store-fixture";

afterEach(cleanup);

function renderToolbar(
  kind: "project" | "cake" = "project",
  mode: "normal" | "browser" | "vscode" = "normal",
  snapshot?: StoreSnapshot,
) {
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project" })],
    sessions: [sessionSummary({ sessionId: "work-log-controls", projectPath: "/project" })],
    snapshot,
  });
  const session = fixture.root.sessionRegistry.load("work-log-controls", "/project");
  const cake = fixture.root.cakeChatCollectionStore.registry.load(CAKE_CHAT_SESSION_ID);
  const view = render(
    <StoreProvider store={fixture.root}>
      {kind === "project" ? (
        mode === "normal" ? (
          <ProjectPaneHeader session={session} browserMode={false} />
        ) : (
          <ProjectWorkspaceControls session={session} mode={mode} browserMode={false} />
        )
      ) : mode === "normal" ? (
        <CakeChatPaneHeader session={cake} />
      ) : (
        <CakeChatWorkspaceControls session={cake} mode={mode} browserMode={false} />
      )}
    </StoreProvider>,
  );
  return {
    user: userEvent.setup(),
    savedSnapshot: () => toSnapshot(fixture.root),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it.each([
  ["project", "normal"],
  ["project", "browser"],
  ["project", "vscode"],
  ["cake", "normal"],
  ["cake", "browser"],
  ["cake", "vscode"],
] as const)("exposes both work-log controls after Terminal in %s / %s", async (kind, mode) => {
  using fixture = renderToolbar(kind, mode);
  const trigger = screen.getByRole("button", { name: "Work log display options" });
  const buttons = screen.getAllByRole("button");
  expect(buttons[buttons.indexOf(trigger) - 1]).toBe(
    screen.getByRole("button", { name: "Terminal" }),
  );
  // One glyph, the same size as its neighbors; the popover shows the current choices.
  expect(trigger.querySelectorAll("svg")).toHaveLength(1);
  await fixture.user.click(trigger);
  for (const name of [
    "Auto view mode",
    "Diff view mode",
    "Log view mode",
    "Collapsed work logs",
    "Compact work logs",
    "Full work logs",
  ]) {
    await fixture.user.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
  }
});

it("preserves defaults and restores toolbar choices from the existing window snapshot across surfaces", async () => {
  let saved: StoreSnapshot;
  {
    using fixture = renderToolbar();
    await fixture.user.click(screen.getByRole("button", { name: "Work log display options" }));
    for (const name of ["Auto view mode", "Collapsed work logs"]) {
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    }
    await fixture.user.click(screen.getByRole("button", { name: "Diff view mode" }));
    await fixture.user.click(screen.getByRole("button", { name: "Compact work logs" }));
    saved = fixture.savedSnapshot();
  }
  using restored = renderToolbar("cake", "browser", saved);
  await restored.user.click(screen.getByRole("button", { name: "Work log display options" }));
  for (const name of ["Diff view mode", "Compact work logs"]) {
    expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
  }
});

it("removes obsolete Settings search destinations for work-log display", () => {
  expect(JSON.stringify(SETTINGS_NAV_GROUPS)).not.toContain("setting-work-log-display");
});
