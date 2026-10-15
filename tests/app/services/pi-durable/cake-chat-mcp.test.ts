import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
async function fakeServer(calls: unknown[]) {
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
    else if (message.method === "tools/list") reply({ tools });
    else if (message.method === "tools/call") {
      calls.push(message.params);
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
