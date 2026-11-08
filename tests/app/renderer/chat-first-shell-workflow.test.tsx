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

it("keeps utilities reachable after closing Workspace and returns from dedicated application views", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["beta"] });
  const rail = () =>
    within(screen.getByRole("navigation", { name: "Projects and global utilities" }));
  await fixture.user.click(screen.getByRole("button", { name: "Close Workspace" }));
  expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
  for (const view of ["Settings", "Automations"]) {
    await fixture.user.click(rail().getByRole("button", { name: view }));
    expect(screen.getByRole("heading", { name: view })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Projects and global utilities" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
    await fixture.user.click(screen.getByRole("button", { name: "Back to chat" }));
    expect(document.querySelector('[data-slot="workspace"]')?.getAttribute("data-session-id")).toBe(
      "beta",
    );
  }
  await fixture.user.click(rail().getByRole("button", { name: "Open Cake Chat" }));
  const breadcrumb = within(screen.getByRole("navigation", { name: "Conversation breadcrumb" }));
  expect(breadcrumb.getAllByRole("button")).toHaveLength(1);
  expect(breadcrumb.getByRole("button", { name: "Cake Chat" })).toBeTruthy();
  await fixture.user.click(screen.getByRole("button", { name: "Open Workspace" }));
  const workspace = within(screen.getByRole("complementary", { name: "Workspace" }));
  await fixture.user.click(workspace.getByRole("button", { name: /^Sessions/ }));
  expect(
    workspace.getByRole("button", { name: "Choose destination for new session" }),
  ).toBeTruthy();
  await fixture.user.click(workspace.getByRole("button", { name: /^To-dos/ }));
  expect(workspace.getByRole("searchbox", { name: "Search to-dos" })).toBeTruthy();
});

it("keeps one shell toggle mounted through close and reopen, outside the project rail", async () => {
  using fixture = renderAppShellNavigation({}, { history: ["beta"] });
  const rail = within(screen.getByRole("navigation", { name: "Projects and global utilities" }));
  const toggle = screen.getByRole("button", { name: "Close Workspace" });
  const host = toggle.closest('[data-slot="shell-workspace-controls"]');
  expect(host).toBeTruthy();
  expect(rail.queryByRole("button", { name: /^(Close|Open) Workspace$/ })).toBeNull();
  const globalPlus = rail.getByRole("button", { name: "New session" });
  expect(screen.getAllByRole("button", { name: /^(Close|Open) Workspace$/ })).toHaveLength(1);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.hasAttribute("aria-pressed")).toBe(false);
  expect(toggle.querySelector("svg path")?.getAttribute("d")).toBe("M15 4v16");
  const appearance = toggle.className;
  await fixture.user.click(toggle);
  expect(screen.queryByRole("complementary", { name: "Workspace" })).toBeNull();
  expect(screen.getByRole("button", { name: "Open Workspace" })).toBe(toggle);
  expect(rail.getByRole("button", { name: "New session" })).toBe(globalPlus);
  expect(toggle.closest('[data-slot="shell-workspace-controls"]')).toBe(host);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(toggle.hasAttribute("aria-pressed")).toBe(false);
  expect(toggle.className).toBe(appearance);
  expect(toggle.querySelector("svg path")?.getAttribute("d")).toBe("M15 4v16");
  toggle.focus();
  await fixture.user.keyboard("{Enter}");
  expect(screen.getByRole("button", { name: "Close Workspace" })).toBe(toggle);
  expect(screen.getByRole("complementary", { name: "Workspace" }).id).toBe(
    toggle.getAttribute("aria-controls"),
  );
});
