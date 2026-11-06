/** @vitest-environment jsdom */
import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Client } from "../../../src/renderer/client/Client";
import { renderAppShellNavigation } from "./app-shell-navigation-fixture";

afterEach(cleanup);

it("opens Project settings from a project context menu without changing the focused conversation", async () => {
  const menu = vi.fn<Client["electron"]["showProjectContextMenu"]>(async () => "settings");
  using fixture = renderAppShellNavigation(
    { electron: { showProjectContextMenu: menu } },
    { history: ["beta"] },
  );
  const rail = within(screen.getByRole("navigation", { name: "Projects and global utilities" }));
  await fixture.user.pointer({
    target: rail.getByRole("button", { name: "Open Project Chat for alpha" }),
    keys: "[MouseRight]",
  });
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Choose icon…" })).toBeTruthy();
  expect(document.querySelector('[data-slot="workspace"]')?.getAttribute("data-session-id")).toBe(
    "beta",
  );
  expect(menu).toHaveBeenCalledWith(expect.objectContaining({ path: "/alpha" }));
});

it("keeps global utilities usable when Workspace is closed and reopens the exclusive accessory", async () => {
  using fixture = renderAppShellNavigation();
  const rail = within(screen.getByRole("navigation", { name: "Projects and global utilities" }));
  await fixture.user.click(rail.getByRole("button", { name: "Close Workspace" }));
  expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
  await fixture.user.click(rail.getByRole("button", { name: "Settings" }));
  expect(screen.getByRole("heading", { name: "Settings" })).toBeTruthy();
  await fixture.user.click(rail.getByRole("button", { name: "Automations" }));
  expect(screen.getByRole("heading", { name: "Automations" })).toBeTruthy();
  await fixture.user.click(rail.getByRole("button", { name: "Open Cake Chat" }));
  await fixture.user.click(rail.getByRole("button", { name: "Open Workspace" }));
  const workspace = within(screen.getByRole("complementary", { name: "Workspace" }));
  await fixture.user.click(workspace.getByRole("button", { name: /^Sessions/ }));
  expect(workspace.getByRole("searchbox", { name: "Search sessions" })).toBeTruthy();
  await fixture.user.click(workspace.getByRole("button", { name: /^To-dos/ }));
  expect(workspace.getByRole("searchbox", { name: "Search to-dos" })).toBeTruthy();
});
