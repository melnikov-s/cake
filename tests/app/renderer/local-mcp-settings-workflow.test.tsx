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

afterEach(cleanup);
async function setup(failure = false) {
  let snapshot: LocalMcpSnapshot = {
    configuration: defaultLocalMcpConfiguration(),
    runtime: { status: "disabled" },
  };
  const changes: LocalMcpConfiguration[] = [];
  let tokenRevision = 1;
  const configuration = () =>
    JSON.stringify({
      mcpServers: {
        cake: {
          type: "http",
          url: snapshot.runtime.url,
          headers: { Authorization: `Bearer token-${tokenRevision}` },
        },
      },
    });
  const fixture = createRendererStoreFixture({
    client: {
      mcpSettings: {
        get: async () => ({ scope: {}, revision: "initial", entries: [] }),
        serverGet: async () => snapshot,
        serverConfigure: async (input) => {
          changes.push(input);
          snapshot = {
            configuration: input,
            runtime: input.enabled
              ? failure
                ? { status: "error", error: "Port is already in use." }
                : { status: "serving", url: `http://127.0.0.1:${input.port}/mcp` }
              : { status: "disabled" },
          };
          if (input.enabled && !failure)
            snapshot = { ...snapshot, clientConfiguration: configuration() };
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
      section.getByRole("switch", { name: "Allow full control of Cake" }).hasAttribute("disabled"),
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

it("enables full-control access, copies client config, changes port, rotates and disables", async () => {
  using f = await setup();
  expect(f.section.getByText("Off")).toBeDefined();
  await f.user.click(f.section.getByRole("switch", { name: "Allow full control of Cake" }));
  await f.section.findByText("Running");
  expect(f.changes[0]).toEqual({ enabled: true, port: 4318 });
  expect(f.section.getByText("http://127.0.0.1:4318/mcp")).toBeDefined();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await f.user.click(f.section.getByRole("button", { name: "Copy MCP client configuration" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(expect.stringContaining("Bearer token-1")));
  await f.user.clear(f.section.getByRole("textbox", { name: "MCP server port" }));
  await f.user.type(f.section.getByRole("textbox", { name: "MCP server port" }), "4319");
  await f.user.click(f.section.getByRole("button", { name: "Apply" }));
  await f.section.findByText("http://127.0.0.1:4319/mcp");
  expect(f.changes[1]).toEqual({ enabled: true, port: 4319 });
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
  await f.user.clear(f.section.getByRole("textbox", { name: "MCP server port" }));
  await f.user.click(f.section.getByRole("switch", { name: "Allow full control of Cake" }));
  await f.section.findByText("Off");
  expect(f.changes.at(-1)).toEqual({ enabled: false, port: 4319 });
  copy.mockRestore();
});

it("shows bind failures and still lets the user turn access off", async () => {
  using f = await setup(true);
  await f.user.click(f.section.getByRole("switch", { name: "Allow full control of Cake" }));
  await f.section.findByText("Port is already in use.");
  expect(f.section.getByText("Failed")).toBeDefined();
  await f.user.click(f.section.getByRole("switch", { name: "Allow full control of Cake" }));
  await f.section.findByText("Off");
  expect(f.changes.at(-1)?.enabled).toBe(false);
});
