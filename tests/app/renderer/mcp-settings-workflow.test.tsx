/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { McpSettings, makeMcpSettingsLayer } from "../../../src/services/pi/McpSettings";
import { SettingsPage } from "../../../src/renderer/components/settings-page";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord } from "./fixtures/catalog-fixtures";

const backendPath = "/remote-backend/pi/mcp.json";
async function setup(project = false, trusted = true) {
  const contents = new Map<string, string>([
    [
      backendPath,
      JSON.stringify({
        unrelated: { preserve: true },
        autoEnableCodemode: false,
        mcpServers: {
          docs: {
            url: "https://example.com/mcp",
            headers: { Authorization: "!never execute this" },
            oauth: { clientSecret: "native-secret" },
            exposure: "deferred",
            custom: { keep: true },
          },
        },
      }),
    ],
  ]);
  const reads: string[] = [];
  const reloads: string[] = [];
  const runtime = ManagedRuntime.make(
    makeMcpSettingsLayer("/remote-backend/pi", {
      read: (path) => {
        reads.push(path);
        return contents.get(path) ?? "";
      },
      write: (path, text) => {
        contents.set(path, text);
      },
    }),
  );
  const fixture = createRendererStoreFixture({
    projects: [projectRecord({ path: "/project", name: "Project" })],
    client: {
      mcpSettings: {
        get: (input, options) => {
          if (input.projectPath && !trusted)
            return Promise.reject(
              new Error("Open and trust this Project before editing its MCP configuration."),
            );
          return runtime.runPromise(
            Effect.flatMap(McpSettings, (settings) => settings.load(input)),
            options,
          );
        },
        mutate: async (input, options) => {
          const value = await runtime.runPromise(
            Effect.flatMap(McpSettings, (settings) => settings.mutate(input)),
            options,
          );
          reloads.push(input.projectPath ?? "all");
          return value;
        },
      },
      workspaces: { loadStagedSlashCommands: async () => [] },
    },
  });
  if (project) {
    fixture.root.projectWorkbenchStore.projectOpenStore.activate("/project");
    await fixture.root.projectWorkbenchStore.startNewSession("/project");
  }
  fixture.root.settingsStore.selectPage("mcp");
  const view = render(<SettingsPage settings={fixture.root.settingsStore} />);
  await screen.findByRole("button", { name: "Edit docs" });
  return {
    contents,
    reads,
    reloads,
    user: userEvent.setup(),
    [Symbol.dispose]() {
      view.unmount();
      fixture[Symbol.dispose]();
      void runtime.dispose();
    },
  };
}
async function replace(user: ReturnType<typeof userEvent.setup>, name: string, value: string) {
  const field = screen.getByRole("textbox", { name });
  await user.clear(field);
  await user.type(field, value.replaceAll("{", "{{"));
}
afterEach(cleanup);
describe("Native MCP Settings with real config storage and controlled service boundaries", () => {
  it("edits masked secrets without evaluating commands; preserves unrelated native config and reloads on the remote backend", async () => {
    using fixture = await setup();
    await fixture.user.click(screen.getByRole("button", { name: "Edit docs" }));
    const advanced = screen.getByRole("textbox", { name: "MCP advanced configuration" });
    expect(advanced.getAttribute("value") ?? (advanced as HTMLTextAreaElement).value).not.toContain(
      "native-secret",
    );
    expect((advanced as HTMLTextAreaElement).value).not.toContain("never execute");
    await fixture.user.type(
      screen.getByRole("textbox", { name: "MCP description" }),
      "Documentation tools",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Save MCP server" }));
    await screen.findByText("Documentation tools");
    const document = JSON.parse(fixture.contents.get(backendPath) ?? "{}");
    expect(document).toMatchObject({
      unrelated: { preserve: true },
      autoEnableCodemode: false,
      mcpServers: {
        docs: {
          headers: { Authorization: "!never execute this" },
          oauth: { clientSecret: "native-secret" },
          custom: { keep: true },
        },
      },
    });
    expect(fixture.reloads).toEqual(["all"]);
    await fixture.user.click(screen.getByRole("button", { name: "Reveal configured secrets" }));
    await fixture.user.click(await screen.findByRole("button", { name: "Edit docs" }));
    expect(
      (screen.getByRole("textbox", { name: "MCP advanced configuration" }) as HTMLTextAreaElement)
        .value,
    ).toContain("native-secret");
    await fixture.user.click(screen.getByRole("button", { name: "Refresh MCP" }));
    await screen.findByRole("button", { name: "Edit docs" });
    expect(fixture.reads.every((path) => path.startsWith("/remote-backend/"))).toBe(true);
    await fixture.user.click(screen.getByRole("button", { name: "Disable docs" }));
    await screen.findByRole("button", { name: "Enable docs" });
    await fixture.user.click(screen.getByRole("button", { name: "Enable docs" }));
    await screen.findByRole("button", { name: "Disable docs" });
    await fixture.user.click(screen.getByRole("button", { name: "Remove docs" }));
    await screen.findByText("No MCP servers configured.");
  });
  it("adds local executable arguments, env and cwd; rejects invalid advanced config and stale cross-window edits", async () => {
    using fixture = await setup();
    await fixture.user.click(screen.getByRole("button", { name: "Add MCP server" }));
    await fixture.user.type(screen.getByRole("textbox", { name: "MCP server name" }), "local");
    await fixture.user.type(screen.getByRole("textbox", { name: "MCP executable or URL" }), "npx");
    await fixture.user.type(screen.getByRole("textbox", { name: "MCP arguments" }), "-y\nserver");
    await fixture.user.type(
      screen.getByRole("textbox", { name: "MCP working directory" }),
      "./tools",
    );
    await replace(fixture.user, "MCP environment", '{"TOKEN":"${TOKEN}"}');
    await replace(fixture.user, "MCP advanced configuration", '{"timeout":-1}');
    await fixture.user.click(screen.getByRole("button", { name: "Save MCP server" }));
    await screen.findByText(/Invalid MCP config:/);
    expect(fixture.reloads).toEqual([]);
    await replace(
      fixture.user,
      "MCP advanced configuration",
      '{"timeout":30,"toolExposure":{"delete_*":"hidden"}}',
    );
    fixture.contents.set(
      backendPath,
      JSON.stringify({ mcpServers: { docs: { url: "https://example.com/changed" } } }),
    );
    await fixture.user.click(screen.getByRole("button", { name: "Save MCP server" }));
    await screen.findByText(/MCP configuration changed/);
    await fixture.user.click(screen.getByRole("button", { name: "Refresh MCP" }));
    await screen.findByRole("button", { name: "Edit docs" });
    await fixture.user.click(screen.getByRole("button", { name: "Add MCP server" }));
    await fixture.user.type(screen.getByRole("textbox", { name: "MCP server name" }), "local");
    await fixture.user.type(screen.getByRole("textbox", { name: "MCP executable or URL" }), "npx");
    await fixture.user.type(screen.getByRole("textbox", { name: "MCP arguments" }), "-y\nserver");
    await fixture.user.type(
      screen.getByRole("textbox", { name: "MCP working directory" }),
      "./tools",
    );
    await replace(fixture.user, "MCP environment", '{"TOKEN":"${TOKEN}"}');
    await fixture.user.click(screen.getByRole("button", { name: "Save MCP server" }));
    await screen.findByRole("button", { name: "Edit local" });
    expect(JSON.parse(fixture.contents.get(backendPath) ?? "{}").mcpServers.local).toMatchObject({
      command: "npx",
      args: ["-y", "server"],
      cwd: "./tools",
      env: { TOKEN: "${TOKEN}" },
    });
    await fixture.user.click(screen.getByRole("button", { name: "Add MCP server" }));
    await fixture.user.type(screen.getByRole("textbox", { name: "MCP server name" }), "http_docs");
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "MCP transport" }),
      "http",
    );
    await fixture.user.type(
      screen.getByRole("textbox", { name: "MCP executable or URL" }),
      "https://docs.example.com/mcp",
    );
    await fixture.user.click(screen.getByRole("button", { name: "Save MCP server" }));
    await screen.findByRole("button", { name: "Edit http_docs" });
    expect(JSON.parse(fixture.contents.get(backendPath) ?? "{}").mcpServers.http_docs.url).toBe(
      "https://docs.example.com/mcp",
    );
  });
  it("shows exact-name Project overrides and reveals backend config after removing the override", async () => {
    using fixture = await setup(true);
    fixture.contents.set(
      "/project/.pi/mcp.json",
      JSON.stringify({
        other: "keep",
        mcpServers: { docs: { url: "https://project.example/mcp", enabled: false } },
      }),
    );
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "MCP configuration scope" }),
      "project",
    );
    await screen.findByText("Overridden by Project");
    await screen.findByRole("button", { name: "Enable docs" });
    await fixture.user.click(screen.getByRole("button", { name: "Remove docs" }));
    await waitFor(() => expect(screen.queryByText("Overridden by Project")).toBeNull());
    expect(screen.getByRole("button", { name: "Override docs in Project" })).toBeDefined();
    expect(JSON.parse(fixture.contents.get("/project/.pi/mcp.json") ?? "{}")).toEqual({
      other: "keep",
      mcpServers: {},
    });
    expect(fixture.reloads).toEqual(["/project"]);
  });
  it("rejects untrusted Project access before reading any Project config", async () => {
    using fixture = await setup(true, false);
    await fixture.user.selectOptions(
      screen.getByRole("combobox", { name: "MCP configuration scope" }),
      "project",
    );
    await screen.findByText("Open and trust this Project before editing its MCP configuration.");
    expect(fixture.reads).not.toContain("/project/.pi/mcp.json");
  });
});
