import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JsonRpcMessage, McpTransport } from "@earendil-works/pi-mcp";
import {
  shutdownDiagnostics,
  shutdownResource,
  type ShutdownRecord,
} from "../../../../src/services/diagnostics/shutdown-diagnostics";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CakeChatMcp,
  loadCakeChatMcpServers,
  resolveMcpConfigValue,
  type CakeChatMcpServer,
} from "../../../../src/services/pi-durable/cake-chat-mcp";

const tools = [
  { name: "slack_search", description: "Search Slack messages", inputSchema: { type: "object" } },
  { name: "vault_search", description: "Search Vault pages", inputSchema: { type: "object" } },
  { name: "admin_delete", description: "Delete things", inputSchema: { type: "object" } },
];

/** A minimal MCP server: initialize, tools/list and an echoing tools/call. */
async function fakeServer(calls: unknown[], onCall?: () => boolean, offeredTools = tools) {
  const { client, server } = createInMemoryTransportPair();
  server.onMessage((message: JsonRpcMessage) => {
    if (!("id" in message) || !("method" in message)) return;
    const reply = (result: unknown) => void server.send({ jsonrpc: "2.0", id: message.id, result });
    if (message.method === "initialize")
      reply({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1" },
      });
    else if (message.method === "tools/list") reply({ tools: offeredTools });
    else if (message.method === "tools/call") {
      calls.push(message.params);
      if (onCall?.() === false) return;
      reply({ content: [{ type: "text", text: `called ${JSON.stringify(message.params)}` }] });
    }
  });
  await server.start();
  return client;
}

const gateway: CakeChatMcpServer = {
  name: "tool-gateway",
  config: { url: "https://gateway.invalid/mcp", toolExposure: { "admin_*": "hidden" } },
};
const open: CakeChatMcp[] = [];
const cleanup: string[] = [];
afterEach(async () => {
  shutdownDiagnostics.finish("cancelled");
  await Promise.all(open.splice(0).map((mcp) => mcp.close()));
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function mcp(calls: unknown[] = []) {
  let connections = 0;
  const instance = new CakeChatMcp([gateway], {
    cwd: "/scratch",
    createTransport: async () => {
      connections += 1;
      return fakeServer(calls);
    },
  });
  open.push(instance);
  return { instance, connections: () => connections };
}

describe("Cake Chat MCP access", () => {
  it.each(["success", "failure"] as const)(
    "identifies stalled initialization and individual client close (%s), preserving swallowed-close policy",
    async (outcome) => {
      const startup = Promise.withResolvers<McpTransport>();
      const release = Promise.withResolvers<void>();
      const closeEntered = Promise.withResolvers<void>();
      const transport = await fakeServer([]);
      const close = transport.close.bind(transport);
      transport.close = async () => {
        closeEntered.resolve();
        await release.promise;
        await close();
        if (outcome === "failure") throw new Error("PRIVATE close error");
      };
      const instance = new CakeChatMcp([gateway], {
        cwd: "/private/workspace",
        createTransport: () => startup.promise,
      });
      open.push(instance);
      const discovery = instance.search(undefined, undefined);
      const closing = instance.close();
      const records: ShutdownRecord[] = [];
      shutdownDiagnostics.start((record) => records.push(record));
      const resource = shutdownResource(`/private/workspace\0${gateway.name}`);
      expect(records.at(-1)?.pending).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ operation: "durable.mcp.initialize", resource }),
          expect.objectContaining({ operation: "durable.mcp.awaitInitialization", resource }),
          expect.objectContaining({ operation: "durable.mcp.close", resource }),
        ]),
      );
      startup.resolve(transport);
      await closeEntered.promise;
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "completed",
          operation: "durable.mcp.awaitInitialization",
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          event: "started",
          operation: "durable.mcp.client.close",
          resource,
        }),
      );
      expect(records).not.toContainEqual(
        expect.objectContaining({ event: "completed", operation: "durable.mcp.close" }),
      );
      release.resolve();
      await discovery;
      await expect(closing).resolves.toBeUndefined();
      expect(records).toContainEqual(
        expect.objectContaining({
          event: outcome === "success" ? "completed" : "failed",
          operation: "durable.mcp.client.close",
          resource,
        }),
      );
      expect(JSON.stringify(records)).not.toMatch(/PRIVATE|\/private|gateway.invalid|tool-gateway/);
    },
  );

  it("discovers servers, searches tools and hides tools the config hides", async () => {
    const { instance, connections } = mcp();
    expect(instance.list()).toEqual([{ server: "tool-gateway", transport: "http" }]);
    expect(await instance.search("search", undefined)).toEqual({
      total: 2,
      matches: [
        { server: "tool-gateway", tool: "slack_search", description: "Search Slack messages" },
        { server: "tool-gateway", tool: "vault_search", description: "Search Vault pages" },
      ],
    });
    expect((await instance.search("delete", undefined)).total).toBe(0);
    await instance.describe("tool-gateway", "slack_search");
    expect(connections()).toBe(1);
  });

  it("calls one tool and returns model content", async () => {
    const calls: unknown[] = [];
    const { instance } = mcp(calls);
    const result = await instance.call(
      "tool-gateway",
      "slack_search",
      { query: "deploy" },
      undefined,
    );
    expect(calls).toEqual([{ name: "slack_search", arguments: { query: "deploy" } }]);
    expect(result.isError).toBe(false);
    expect(result.content[0]).toMatchObject({ type: "text" });
  });

  it("explains unknown servers and tools", async () => {
    const { instance } = mcp();
    await expect(instance.describe("slack", "x")).rejects.toThrow(
      'Unknown MCP server "slack". Available: tool-gateway.',
    );
    await expect(instance.call("tool-gateway", "admin_delete", {}, undefined)).rejects.toThrow(
      'has no tool "admin_delete"',
    );
  });

  it("prefers mcp.json over extension registrations and skips disabled servers", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "cake-chat-mcp-"));
    cleanup.push(agentDirectory);
    await writeFile(
      join(agentDirectory, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "tool-gateway": { url: "https://configured.invalid/mcp" },
          off: { command: "server", enabled: false },
          broken: { headers: {} },
        },
      }),
    );
    const loaded = await loadCakeChatMcpServers({
      agentDirectory,
      registered: [
        { name: "tool-gateway", config: { url: "https://extension.invalid" }, extensionPath: "x" },
        { name: "docs", config: { command: "docs-mcp" }, extensionPath: "y" },
      ],
    });
    expect(loaded.servers).toEqual([
      { name: "tool-gateway", config: { url: "https://configured.invalid/mcp" } },
      { name: "docs", config: { command: "docs-mcp" } },
    ]);
    expect(loaded.errors).toEqual([expect.stringContaining('MCP server "broken"')]);
  });

  it.each(["codemode", "deferred", "direct"] as const)(
    "keeps hidden-default servers with %s exceptions without exposing other tools",
    async (exposure) => {
      const agentDirectory = await mkdtemp(join(tmpdir(), "cake-chat-mcp-exposure-"));
      cleanup.push(agentDirectory);
      await writeFile(
        join(agentDirectory, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            inspector: {
              url: "https://inspector.invalid/mcp",
              exposure: "hidden",
              toolExposure: { "*_search": exposure, vault_search: "hidden" },
            },
            hidden: { command: "never-start", exposure: "hidden" },
            hiddenOverrides: {
              command: "never-start",
              exposure: "hidden",
              toolExposure: { "*": "hidden" },
            },
            disabled: {
              command: "never-start",
              enabled: false,
              exposure: "hidden",
              toolExposure: { slack_search: exposure },
            },
          },
        }),
      );
      const loaded = await loadCakeChatMcpServers({ agentDirectory, registered: [] });
      expect(loaded.errors).toEqual([]);
      expect(loaded.servers.map((server) => server.name)).toEqual(["inspector"]);
      const calls: unknown[] = [];
      const createTransport = vi.fn(() => fakeServer(calls));
      const instance = new CakeChatMcp(loaded.servers, { cwd: "/scratch", createTransport });
      open.push(instance);
      expect(instance.list()).toEqual([{ server: "inspector", transport: "http" }]);
      expect(
        (await instance.search(undefined, undefined)).matches.map((tool) => tool.tool),
      ).toEqual(["slack_search"]);
      expect(await instance.describe("inspector", "slack_search")).toMatchObject({
        tool: "slack_search",
      });
      await instance.call("inspector", "slack_search", {}, undefined);
      for (const tool of ["vault_search", "admin_delete"]) {
        await expect(instance.describe("inspector", tool)).rejects.toThrow("has no tool");
        await expect(instance.call("inspector", tool, {}, undefined)).rejects.toThrow(
          "has no tool",
        );
      }
      for (const server of ["hidden", "hiddenOverrides", "disabled"]) {
        await expect(instance.describe(server, "slack_search")).rejects.toThrow(
          "Unknown MCP server",
        );
        await expect(instance.call(server, "slack_search", {}, undefined)).rejects.toThrow(
          "Unknown MCP server",
        );
      }
      expect(calls).toHaveLength(1);
      expect(createTransport).toHaveBeenCalledTimes(1);
    },
  );

  it("retains extension-registered hidden-default inspectors with only the four read-only exceptions", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "cake-chat-mcp-extension-"));
    cleanup.push(agentDirectory);
    const visible = ["rst_list_tabs", "rst_list_roots", "rst_inspect", "rst_list_operations"];
    const loaded = await loadCakeChatMcpServers({
      agentDirectory,
      registered: [
        {
          name: "cake-rst-development-main",
          extensionPath: "fixture",
          config: {
            url: "https://inspector.invalid/mcp",
            exposure: "hidden",
            toolExposure: Object.fromEntries(visible.map((name) => [name, "codemode" as const])),
          },
        },
      ],
    });
    const offered = [...visible, "rst_call", "rst_write"].map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object" },
    }));
    const instance = new CakeChatMcp(loaded.servers, {
      cwd: "/scratch",
      createTransport: () => fakeServer([], undefined, offered),
    });
    open.push(instance);
    expect((await instance.search(undefined, undefined)).matches.map((tool) => tool.tool)).toEqual(
      visible,
    );
    for (const tool of visible)
      await expect(instance.describe("cake-rst-development-main", tool)).resolves.toMatchObject({
        tool,
      });
    for (const tool of ["rst_call", "rst_write"])
      await expect(instance.call("cake-rst-development-main", tool, {}, undefined)).rejects.toThrow(
        "has no tool",
      );
  });

  it("honors exact exceptions before the first matching wildcard", async () => {
    const instance = new CakeChatMcp(
      [
        {
          ...gateway,
          config: {
            ...gateway.config,
            exposure: "hidden",
            toolExposure: { "*": "hidden", "*_search": "direct", slack_search: "deferred" },
          },
        },
      ],
      { cwd: "/scratch", createTransport: () => fakeServer([]) },
    );
    open.push(instance);
    expect((await instance.search(undefined, undefined)).matches.map((tool) => tool.tool)).toEqual([
      "slack_search",
    ]);
    await expect(instance.call(gateway.name, "vault_search", {}, undefined)).rejects.toThrow(
      "has no tool",
    );
  });

  it("reloads additions, removals and exposure changes from configuration and closes old clients", async () => {
    const agentDirectory = await mkdtemp(join(tmpdir(), "cake-chat-mcp-reload-"));
    cleanup.push(agentDirectory);
    const configure = async (mcpServers: unknown) => {
      await writeFile(join(agentDirectory, "mcp.json"), JSON.stringify({ mcpServers }));
      return loadCakeChatMcpServers({ agentDirectory, registered: [] });
    };
    const initial = await configure({ gateway: gateway.config, removed: gateway.config });
    const closed: string[] = [];
    const connected: string[] = [];
    const instance = new CakeChatMcp(initial.servers, {
      cwd: "/scratch",
      createTransport: async ({ name }) => {
        connected.push(name);
        const transport = await fakeServer([]);
        transport.onClose(() => closed.push(name));
        return transport;
      },
    });
    open.push(instance);
    await instance.search(undefined, undefined);
    const updated = await configure({
      gateway: { ...gateway.config, exposure: "hidden", toolExposure: { vault_search: "direct" } },
      added: { command: "added" },
      hidden: { ...gateway.config, exposure: "hidden" },
    });
    await instance.reload(updated.servers);
    expect(closed.sort()).toEqual(["gateway", "removed"]);
    expect(instance.list().map((entry) => entry.server)).toEqual(["gateway", "added"]);
    await expect(instance.describe("removed", "slack_search")).rejects.toThrow(
      "Unknown MCP server",
    );
    await expect(instance.describe("gateway", "slack_search")).rejects.toThrow("has no tool");
    await expect(instance.describe("gateway", "vault_search")).resolves.toMatchObject({
      tool: "vault_search",
    });
    await instance.describe("added", "slack_search");
    expect(connected).toEqual(["gateway", "removed", "gateway", "added"]);
    await instance.reload((await configure({})).servers);
    expect(instance.list()).toEqual([]);
    expect(closed).toHaveLength(4);
  });

  it("does not dispatch a pending call under replaced authority and disposal drains retired initialization", async () => {
    const startup = Promise.withResolvers<McpTransport>();
    const closeEntered = Promise.withResolvers<void>();
    const releaseClose = Promise.withResolvers<void>();
    const calls: unknown[] = [];
    const transport = await fakeServer(calls);
    const close = transport.close.bind(transport);
    transport.close = async () => {
      closeEntered.resolve();
      await releaseClose.promise;
      await close();
    };
    const instance = new CakeChatMcp([gateway], {
      cwd: "/scratch",
      createTransport: () => startup.promise,
    });
    open.push(instance);
    const call = expect(instance.call(gateway.name, "slack_search", {}, undefined)).rejects.toThrow(
      "has closed",
    );
    const reloaded = instance.reload([]);
    const disposed = vi.fn();
    const closing = instance.close().then(disposed);
    expect(() => instance.reload([gateway])).toThrow("has closed");
    startup.resolve(transport);
    await closeEntered.promise;
    expect(disposed).not.toHaveBeenCalled();
    releaseClose.resolve();
    await Promise.all([call, reloaded, closing]);
    expect(calls).toEqual([]);
    expect(instance.list()).toEqual([]);
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("rejects pending discovery on reload, allowing a fresh connection without stale cleanup deleting it", async () => {
    const startup = Promise.withResolvers<McpTransport>();
    const first = await fakeServer([]);
    const createTransport = vi
      .fn()
      .mockImplementationOnce(() => startup.promise)
      .mockImplementation(() => fakeServer([]));
    const instance = new CakeChatMcp([gateway], { cwd: "/scratch", createTransport });
    open.push(instance);
    const pending = expect(instance.describe(gateway.name, "slack_search")).rejects.toThrow(
      "configuration changed",
    );
    const reloaded = instance.reload([gateway]);
    await instance.describe(gateway.name, "slack_search");
    startup.resolve(first);
    await Promise.all([pending, reloaded]);
    await instance.describe(gateway.name, "slack_search");
    expect(createTransport).toHaveBeenCalledTimes(2);
  });

  it("cancels calls already in flight when their configuration is removed", async () => {
    const entered = Promise.withResolvers<void>();
    const instance = new CakeChatMcp([gateway], {
      cwd: "/scratch",
      createTransport: () =>
        fakeServer([], () => {
          entered.resolve();
          return false;
        }),
    });
    open.push(instance);
    const call = expect(instance.call(gateway.name, "slack_search", {}, undefined)).rejects.toThrow(
      /closed/i,
    );
    await entered.promise;
    await instance.reload([]);
    await call;
  });

  it("does not dispatch calls cancelled during initialization", async () => {
    const startup = Promise.withResolvers<McpTransport>();
    const calls: unknown[] = [];
    const instance = new CakeChatMcp([gateway], {
      cwd: "/scratch",
      createTransport: () => startup.promise,
    });
    open.push(instance);
    const controller = new AbortController();
    const call = expect(
      instance.call(gateway.name, "slack_search", {}, controller.signal),
    ).rejects.toThrow(/abort/i);
    controller.abort();
    startup.resolve(await fakeServer(calls));
    await call;
    expect(calls).toEqual([]);
  });

  it("resolves credentials like Pi: env templates, escapes and commands", async () => {
    const env = { TOKEN: "abc" };
    expect(await resolveMcpConfigValue("Bearer ${TOKEN}", { cwd: "/", env })).toBe("Bearer abc");
    expect(await resolveMcpConfigValue("$TOKEN-$$", { cwd: "/", env })).toBe("abc-$");
    expect(await resolveMcpConfigValue("!printf 'Bearer %s' x", { cwd: "/", env })).toBe(
      "Bearer x",
    );
    await expect(resolveMcpConfigValue("${MISSING}", { cwd: "/", env })).rejects.toThrow(
      "MISSING is not set",
    );
  });
});
