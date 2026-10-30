/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import {
  defaultLocalMcpConfiguration,
  type LocalMcpConfiguration,
  type LocalMcpSnapshot,
} from "../../../src/contracts/mcp/local-mcp";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";

afterEach(cleanup);
async function setup(failure = false) {
  const projects = [{ path: "/project", name: "Project" }];
  let snapshot: LocalMcpSnapshot = {
    configuration: defaultLocalMcpConfiguration(),
    runtime: { status: "disabled" },
    projects,
  };
  const changes: LocalMcpConfiguration[] = [];
  let tokenRevision = 1;
  const configuration = () =>
    JSON.stringify({
      mcpServers: {
        cake: {
          type: "http",
          url: "http://127.0.0.1:4318/mcp",
          headers: { Authorization: `Bearer token-${tokenRevision}` },
        },
      },
    });
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      mcpSettings: {
        get: async () => ({ scope: {}, revision: "initial", entries: [] }),
        serverGet: async () => snapshot,
        serverConfigure: async (input) => {
          changes.push(input);
          snapshot = {
            configuration: input,
            projects,
            runtime: input.enabled
              ? failure
                ? { status: "error", error: "Port is already in use." }
                : { status: "serving", url: "http://127.0.0.1:4318/mcp" }
              : { status: "disabled" },
            ...(input.enabled && !failure ? { clientConfiguration: configuration() } : {}),
          };
          return snapshot;
        },
        serverRotateToken: async () => {
          tokenRevision++;
          snapshot = { ...snapshot, clientConfiguration: configuration() };
          return snapshot;
        },
      },
    },
  });
  fixture.root.settingsStore.selectPage("mcp");
  const user = userEvent.setup();
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  const section = within(screen.getByRole("region", { name: "Cake MCP server" }));
  await waitFor(() =>
    expect(
      section.getByRole("switch", { name: "Allow Project Project" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  return {
    section,
    changes,
    user,
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
    },
  };
}

it("enables scoped HTTP access, copies client config, changes permissions, rotates and disables", async () => {
  using f = await setup();
  expect(f.section.getByText("Off")).toBeDefined();
  expect(
    f.section.getByRole("switch", { name: "Allow external assistants" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    f.section
      .getByRole("switch", { name: "Read sessions and to-dos" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await f.user.click(f.section.getByRole("switch", { name: "Allow Project Project" }));
  await f.user.click(f.section.getByRole("switch", { name: "Allow external assistants" }));
  await f.section.findByText("Running");
  expect(f.changes[0]).toMatchObject({
    enabled: true,
    projects: ["/project"],
    scopes: ["read"],
    port: 4318,
  });
  expect(f.section.getByText("http://127.0.0.1:4318/mcp")).toBeDefined();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await f.user.click(f.section.getByRole("button", { name: "Copy MCP client configuration" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining("Bearer token-1")));
  await f.user.click(f.section.getByRole("switch", { name: "Launch sessions" }));
  await f.user.click(f.section.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(f.changes[1]?.scopes).toEqual(["read", "launch"]));
  await f.user.click(f.section.getByRole("button", { name: "Reset access token" }));
  await waitFor(() =>
    expect(
      f.section.getByRole("button", { name: "Reset access token" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  await f.user.click(
    f.section.getByRole("button", { name: /Cop(?:y|ied) MCP client configuration/ }),
  );
  await waitFor(() =>
    expect(copy).toHaveBeenLastCalledWith(expect.stringContaining("Bearer token-2")),
  );
  await f.user.click(f.section.getByRole("switch", { name: "Allow external assistants" }));
  await f.section.findByText("Off");
  expect(f.changes.at(-1)?.enabled).toBe(false);
  copy.mockRestore();
});

it("shows bind failures and still lets the user turn access off", async () => {
  using f = await setup(true);
  await f.user.click(f.section.getByRole("switch", { name: "Allow Project Project" }));
  await f.user.click(f.section.getByRole("switch", { name: "Allow external assistants" }));
  await f.section.findByText("Port is already in use.");
  expect(f.section.getByText("Failed")).toBeDefined();
  await f.user.click(f.section.getByRole("switch", { name: "Allow external assistants" }));
  await f.section.findByText("Off");
  expect(f.changes.at(-1)?.enabled).toBe(false);
});
