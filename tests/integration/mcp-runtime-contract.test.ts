import { createProjectSessionRuntime as createCakeSessionRuntime } from "../../src/layers/CakeOperations";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionFactory,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import {
  createCakeMcpExtensions,
  type CakeMcpIntegrationOptions,
} from "../../src/services/pi/runtime/mcp-integration";
import { shutdownCakeSessionExtensions } from "../../src/services/pi/runtime/cake-session-runtime-resources";
import { createCakeExtensionUiContext } from "../../src/services/pi/runtime/extension-compatibility";
import { type CakeSessionRuntime } from "../../src/services/pi/runtime/cake-session-runtime";
import type { JsonObject } from "../../src/contracts/serialization/json-contract";
import type { ExtensionUiIntent } from "../../src/contracts/conversations/session-contract";
import { startMcpServer } from "../fixtures/mcp-server";
import { projectSessionEntries } from "../../src/services/pi/runtime/session-projection";

// The transport is the only fake: Pi still owns protocol negotiation, config,
// discovery, permissions, connections, and commands. No provider requests.
type Transport = ReturnType<McpTransportFactory>;
type Message = Parameters<Transport["send"]>[0];
function deferred() {
  let resolve: () => void = () => {
    throw new Error("Deferred not initialized");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function transportFixture(
  options: { delayedStart?: boolean; delayedCall?: boolean; error?: boolean } = {},
) {
  const started = deferred();
  const allowStart = deferred();
  const called = deferred();
  const closed = deferred();
  const listeners = new Set<Parameters<Transport["onMessage"]>[0]>();
  const closeListeners = new Set<Parameters<Transport["onClose"]>[0]>();
  const requests: Message[] = [];
  let closeCount = 0;
  const transport: Transport = {
    async start() {
      started.resolve();
      if (options.delayedStart) await allowStart.promise;
    },
    async send(message) {
      requests.push(message);
      if (!("method" in message) || !("id" in message)) return;
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: "fixture", version: "1" },
            instructions: "Fixture namespace",
          };
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: "echo",
                description: "Echo fixture",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
          };
          break;
        case "tools/call":
          called.resolve();
          if (options.delayedCall) return;
          result = {
            content: [
              { type: "text", text: "MCP fixture result" },
              { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
            ],
            structuredContent: { value: 42 },
            isError: options.error ?? false,
          };
          break;
        case "resources/list":
          result = {
            resources: [
              { uri: "fixture://note", name: "Fixture note" },
              { uri: "ui://app", name: "Unsupported MCP App" },
            ],
          };
          break;
        case "resources/templates/list":
          result = { resourceTemplates: [] };
          break;
        case "resources/read":
          result = { contents: [{ uri: "fixture://note", text: "Resource text" }] };
          break;
        default:
          throw new Error(`Unexpected MCP request ${message.method}`);
      }
      for (const listener of listeners) listener({ jsonrpc: "2.0", id: message.id, result });
    },
    async close() {
      closeCount += 1;
      for (const listener of closeListeners) listener();
      closed.resolve();
      allowStart.resolve();
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onError() {
      return () => {};
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
  return { transport, started, allowStart, called, closed, requests, closeCount: () => closeCount };
}

const directories: string[] = [];
const sessions: AgentSession[] = [];
const runtimes: CakeSessionRuntime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const session of sessions.splice(0)) {
    await session.abort();
    await shutdownCakeSessionExtensions(session);
    session.dispose();
  }
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directoryFixture() {
  const cwd = await mkdtemp(join(tmpdir(), "cake-mcp-contract-"));
  directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".pi"));
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  return { cwd, agentDir };
}
const server = {
  name: "fixture",
  config: { command: "unused", exposure: "direct" as const },
  source: "fixture",
};
async function openSession(
  options: {
    exposure?: "direct" | "deferred" | "codemode" | "hidden";
    autoEnableCodemode?: boolean;
    extensions?: string[];
    extra?: ExtensionFactory[];
    fixtures?: ReturnType<typeof transportFixture>[];
    loadConfig?: CakeMcpIntegrationOptions["loadConfig"];
    trusted?: boolean;
    directories?: Awaited<ReturnType<typeof directoryFixture>>;
    restriction?: Partial<CakeMcpIntegrationOptions["runtime"]>;
  } = {},
) {
  const { cwd, agentDir } = options.directories ?? (await directoryFixture());
  const fixtures = options.fixtures ?? [transportFixture()];
  const entries: Parameters<McpTransportFactory>[0][] = [];
  const createTransport: McpTransportFactory = (entry) => {
    entries.push(entry);
    const fixture = fixtures[entries.length - 1];
    if (!fixture) throw new Error("Unexpected extra connection");
    return fixture.transport;
  };
  const settingsManager = SettingsManager.inMemory({
    extensions: options.extensions,
    codemode: { mode: "only" },
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      ...createCakeMcpExtensions({
        runtime: { agentDir, ...options.restriction },
        createTransport,
        loadConfig:
          options.loadConfig ??
          (() => ({
            servers: [
              { ...server, config: { ...server.config, exposure: options.exposure ?? "direct" } },
            ],
            errors: [],
            autoEnableCodemode: options.autoEnableCodemode,
          })),
      }),
      ...(options.extra ?? []),
    ],
  });
  await resourceLoader.reload({ resolveProjectTrust: async () => options.trusted ?? true });
  expect(resourceLoader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(cwd),
    ...(options.restriction?.projectInvestigation ? { excludeTools: ["edit", "write"] } : {}),
  });
  sessions.push(session);
  const intents: ExtensionUiIntent[] = [];
  const uiContext = createCakeExtensionUiContext({
    request: async () => undefined,
    state: { statuses: [] },
    emitState: () => {},
    emitIntent: (intent) => intents.push(intent),
    addDiagnostic: () => {},
  });
  const bind = () => session.bindExtensions({ mode: "rpc", uiContext });
  // Real top-level tool pipeline with a deterministic provider-free stream.
  const invoke = async (name: string, args: JsonObject) => {
    const model = session.modelRuntime.getModel("openai", "gpt-4.1-mini");
    if (!model) throw new Error("Fixture model missing");
    await session.modelRuntime.setRuntimeApiKey("openai", "fixture");
    await session.setModel(model);
    let first = true;
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: first
          ? [{ type: "toolCall", id: "fixture-call", name, arguments: args }]
          : [{ type: "text", text: "Done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: first ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      first = false;
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
      return stream;
    };
    const previous = session.messages.length;
    await session.prompt("Fixture tool request");
    const result = session.messages
      .slice(previous)
      .find((message) => message.role === "toolResult");
    if (!result || result.role !== "toolResult") throw new Error("Expected a tool result");
    return { isError: result.isError, result };
  };
  return { session, resourceLoader, fixtures, entries, intents, bind, invoke, cwd, agentDir };
}

describe("Cake native MCP runtime contract", () => {
  it("allows configured MCP in project investigators while keeping edit/write excluded after tool activation", async () => {
    const h = await openSession({ restriction: { auxiliary: true, projectInvestigation: true } });
    await h.bind();
    await h.session.prompt("/mcp");
    expect(h.entries).toHaveLength(1);
    const tools = h.session.getActiveToolNames();
    expect(tools).toContain("mcp__fixture__echo");
    expect(tools).toContain("bash");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("write");
    h.session.setActiveToolsByName([...tools, "edit", "write"]);
    expect(h.session.getActiveToolNames()).not.toContain("edit");
    expect(h.session.getActiveToolNames()).not.toContain("write");
    expect((await h.invoke("mcp__fixture__echo", {})).isError).toBe(false);
    expect(h.session.sessionFile).toBeUndefined();
  });
  it("connects only on session_start and preserves ordinary default tools", async () => {
    const h = await openSession();
    expect(h.entries).toEqual([]);
    expect(h.session.getActiveToolNames()).toContain("read");
    expect(h.session.getActiveToolNames()).not.toContain("codemode");
    expect(h.session.getActiveToolNames()).not.toContain("tool_search");
    await h.bind();
    await h.session.prompt("/mcp");
    expect(h.entries).toHaveLength(1);
    expect(h.session.getActiveToolNames()).toContain("mcp__fixture__echo");
    expect(h.intents).toContainEqual(
      expect.objectContaining({ kind: "notify", message: expect.stringContaining("fixture") }),
    );
    expect(h.session.messages).toEqual([]);
  });
  it.each([true, false])(
    "uses the Cake root and project trust (%s) for native config merging",
    async (trusted) => {
      const dirs = await directoryFixture();
      await writeFile(
        join(dirs.agentDir, "mcp.json"),
        JSON.stringify({ mcpServers: { fixture: { command: "personal", exposure: "direct" } } }),
      );
      await writeFile(
        join(dirs.cwd, ".pi", "mcp.json"),
        JSON.stringify({
          mcpServers: {
            fixture: { command: "project", exposure: "direct" },
            projectOnly: { command: "project-only", exposure: "direct" },
          },
        }),
      );
      // undefined deliberately selects the production loader rather than the fixture loader.
      const nativeConfig = createCakeMcpExtensions({
        runtime: { agentDir: dirs.agentDir },
        createTransport: (entry) => {
          entries.push(entry);
          return transportFixture().transport;
        },
      });
      const entries: Parameters<McpTransportFactory>[0][] = [];
      const settingsManager = SettingsManager.inMemory();
      const loader = new DefaultResourceLoader({
        ...dirs,
        settingsManager,
        extensionFactories: nativeConfig,
        noContextFiles: true,
        noSkills: true,
        noThemes: true,
        noPromptTemplates: true,
      });
      await loader.reload({ resolveProjectTrust: async () => trusted });
      const { session } = await createAgentSession({
        ...dirs,
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.inMemory(dirs.cwd),
      });
      sessions.push(session);
      await session.bindExtensions({ mode: "rpc" });
      await session.prompt("/mcp");
      expect(
        entries.map((entry) => ("command" in entry.config ? entry.config.command : undefined)),
      ).toEqual(trusted ? ["project", "project-only"] : ["personal"]);
      expect(entries[0]?.source).toBe(
        join(trusted ? join(dirs.cwd, ".pi") : dirs.agentDir, "mcp.json"),
      );
    },
  );
  it("admits direct tools that finish connecting after session start", async () => {
    const fixture = transportFixture({ delayedStart: true });
    const h = await openSession({ fixtures: [fixture] });
    await h.bind();
    await fixture.started.promise;
    expect(h.session.getActiveToolNames()).not.toContain("mcp__fixture__echo");
    fixture.allowStart.resolve();
    await h.session.prompt("/mcp");
    expect(h.session.getActiveToolNames()).toContain("mcp__fixture__echo");
  });
  it("applies per-tool exposure overrides rather than widening a hidden server", async () => {
    const h = await openSession({
      loadConfig: () => ({
        errors: [],
        servers: [
          {
            ...server,
            config: { ...server.config, exposure: "hidden", toolExposure: { echo: "direct" } },
          },
        ],
      }),
    });
    await h.bind();
    await h.session.prompt("/mcp");
    expect(h.session.getActiveToolNames()).toContain("mcp__fixture__echo");
    expect((await h.invoke("mcp__fixture__echo", {})).isError).toBe(false);
  });
  it("honors builtin disable settings and replacement commands", async () => {
    for (const options of [
      { extensions: ["-builtin:mcp"] },
      {
        extra: [
          (pi) =>
            pi.registerCommand("mcp", { description: "Replacement", handler: async () => {} }),
        ] satisfies ExtensionFactory[],
      },
    ]) {
      const h = await openSession(options);
      await h.bind();
      expect(h.entries).toEqual([]);
    }
  });
  it.each(["codemode", "tool-search"])("honors independent %s disable settings", async (name) => {
    const h = await openSession({
      exposure: name === "codemode" ? "codemode" : "deferred",
      extensions: [`-builtin:${name}`],
    });
    await h.bind();
    await h.session.prompt("/mcp");
    expect(h.session.getActiveToolNames()).not.toContain(
      name === "codemode" ? "codemode" : "tool_search",
    );
    expect(h.entries).toHaveLength(1);
  });
  it.each([
    {},
    { auxiliary: true },
    { tools: [] },
    { tools: ["read"] },
    { coordinator: { operations: () => [] } },
  ])("preserves capability eligibility %j", async (restriction) => {
    const h = await openSession({ restriction });
    await h.bind();
    if (Object.keys(restriction).length === 0) await h.session.prompt("/mcp");
    expect(h.entries).toHaveLength(Object.keys(restriction).length === 0 ? 1 : 0);
  });
  it("restores loaded deferred declarations after SDK resume", async () => {
    const h = await openSession({
      exposure: "deferred",
      fixtures: [transportFixture(), transportFixture()],
    });
    await h.bind();
    expect(h.session.getActiveToolNames()).toContain("tool_search");
    expect(h.session.getActiveToolNames()).not.toContain("mcp__fixture__echo");
    const result = await h.invoke("tool_search", { query: "echo" });
    expect(result.isError).toBe(false);
    expect(h.session.getActiveToolNames()).toContain("mcp__fixture__echo");
    const manager = h.session.sessionManager;
    await shutdownCakeSessionExtensions(h.session);
    h.session.dispose();
    sessions.splice(sessions.indexOf(h.session), 1);
    await h.resourceLoader.reload({ resolveProjectTrust: async () => true });
    const resumed = await createAgentSession({
      cwd: h.cwd,
      agentDir: h.agentDir,
      resourceLoader: h.resourceLoader,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory(),
    });
    sessions.push(resumed.session);
    await resumed.session.bindExtensions({ mode: "rpc" });
    await resumed.session.prompt("/mcp");
    // Pi 1.3+ restores the recorded declaration loadout without a Cake cache.
    expect(resumed.session.getActiveToolNames()).toContain("tool_search");
    expect(resumed.session.getAllTools().map((tool) => tool.name)).toContain("mcp__fixture__echo");
    expect(resumed.session.getActiveToolNames()).toContain("mcp__fixture__echo");
  });
  it("runs configured codemode in on mode with ordinary tools retained", async () => {
    const h = await openSession({ exposure: "codemode" });
    await h.bind();
    expect(h.session.getActiveToolNames()).toContain("codemode");
    expect(h.session.agent.state.tools.map((tool) => tool.name)).toContain("read");
    const result = await h.invoke("codemode", {
      code: "const r = await tools.mcp__fixture__echo({}); console.log(r.structuredContent.value);",
    });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.result.content)).toContain("42");
  });
  it("respects autoEnableCodemode false and hidden exposure", async () => {
    const h = await openSession({ exposure: "codemode", autoEnableCodemode: false });
    await h.bind();
    await h.session.prompt("/mcp");
    expect(h.session.getActiveToolNames()).not.toContain("codemode");
    const hidden = await openSession({ exposure: "hidden" });
    await hidden.bind();
    await hidden.session.prompt("/mcp");
    const result = await hidden.invoke("mcp__fixture__echo", {});
    expect(result.isError).toBe(true);
    expect(
      hidden.fixtures[0]?.requests.filter((m) => "method" in m && m.method === "tools/call"),
    ).toEqual([]);
  });
  it("applies the same permission hook to direct and script-issued calls", async () => {
    const blocked: string[] = [];
    const h = await openSession({
      exposure: "direct",
      extra: [
        (pi) => {
          pi.on("tool_call", (event) => {
            if (event.toolName.startsWith("mcp__")) {
              blocked.push(event.toolName);
              return { block: true, reason: "Denied" };
            }
          });
        },
      ],
    });
    await h.bind();
    await h.session.prompt("/mcp");
    const direct = await h.invoke("mcp__fixture__echo", {});
    expect(direct.isError).toBe(true);
    h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "codemode"]);
    await h.invoke("codemode", { code: "await tools.mcp__fixture__echo({});" });
    expect(blocked).toEqual(["mcp__fixture__echo", "mcp__fixture__echo"]);
    expect(
      h.fixtures[0]?.requests.filter((m) => "method" in m && m.method === "tools/call"),
    ).toEqual([]);
  });
  it("returns MCP text, images, structured errors and ordinary resources", async () => {
    const h = await openSession({ fixtures: [transportFixture({ error: true })] });
    await h.bind();
    await h.session.prompt("/mcp");
    const result = await h.invoke("mcp__fixture__echo", {});
    expect(result.isError).toBe(true);
    expect(result.result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: "MCP fixture result" }),
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]),
    );
    expect(projectSessionEntries(h.session.sessionManager.getBranch())).toContainEqual(
      expect.objectContaining({
        kind: "tool",
        name: "mcp__fixture__echo",
        state: "error",
        output: expect.stringContaining("MCP fixture result"),
        outputContent: expect.arrayContaining([
          expect.objectContaining({ type: "image", mimeType: "image/png" }),
        ]),
      }),
    );
    const resources = await h.invoke("list_mcp_resources", {});
    expect(JSON.stringify(resources.result.content)).toContain("fixture://note");
    expect(JSON.stringify(resources.result.content)).not.toContain("ui://app");
    const resource = await h.invoke("read_mcp_resource", {
      server: "fixture",
      uri: "fixture://note",
    });
    expect(JSON.stringify(resource.result.content)).toContain("Resource text");
  });
  it("cancels an active call without replaying side effects", async () => {
    const fixture = transportFixture({ delayedCall: true });
    const h = await openSession({ fixtures: [fixture] });
    await h.bind();
    await h.session.prompt("/mcp");
    const pending = h.invoke("mcp__fixture__echo", {});
    await fixture.called.promise;
    await h.session.abort();
    expect((await pending).isError).toBe(true);
    expect(fixture.requests.filter((m) => "method" in m && m.method === "tools/call")).toHaveLength(
      1,
    );
  });
  it("closes old connections on reload and final shutdown before invalidation", async () => {
    const first = transportFixture();
    const second = transportFixture();
    const h = await openSession({ fixtures: [first, second] });
    await h.bind();
    await h.session.prompt("/mcp");
    await h.session.reload();
    await h.session.prompt("/mcp");
    expect(first.closeCount()).toBe(1);
    expect(second.closeCount()).toBe(0);
    await shutdownCakeSessionExtensions(h.session);
    expect(second.closeCount()).toBe(1);
    // Runner contexts are still valid at shutdown completion.
    expect(h.session.extensionRunner.createContext().cwd).toBe(h.cwd);
  });
  it("drops startup completion after shutdown", async () => {
    const fixture = transportFixture({ delayedStart: true });
    const h = await openSession({ fixtures: [fixture] });
    await h.bind();
    await fixture.started.promise;
    const shutdown = shutdownCakeSessionExtensions(h.session);
    fixture.allowStart.resolve();
    await shutdown;
    // Pi's pending startup finishes asynchronously and closes the retired client.
    await h.session.prompt("/mcp");
    expect(fixture.closeCount()).toBeGreaterThanOrEqual(1);
    expect(h.session.getActiveToolNames()).not.toContain("mcp__fixture__echo");
  });
  it.each([true, false])(
    "routes OAuth redirect input through Cake UI (complete=%s), stores credentials/logs in the backend root",
    async (complete) => {
      const { cwd, agentDir } = await directoryFixture();
      const server = await startMcpServer();
      try {
        await writeFile(
          join(agentDir, "mcp.json"),
          JSON.stringify({ mcpServers: { oauth: { url: server.url, exposure: "direct" } } }),
        );
        const intents: ExtensionUiIntent[] = [];
        const inputs: string[] = [];
        const runtime = await createCakeSessionRuntime({
          cwd,
          agentDir,
          trusted: true,
          sessionDir: join(cwd, "sessions"),
          newSession: true,
          onEvent: () => {},
          emitExtensionUiIntent: (intent) => intents.push(intent),
          requestUi: async (request) => {
            expect(request.kind).toBe("text");
            inputs.push(request.title);
            if (!complete) return undefined;
            const notice = intents.findLast(
              (intent) => intent.kind === "notify" && intent.message.includes("/authorize"),
            );
            if (!notice || notice.kind !== "notify")
              throw new Error("Authorization URL was not shown");
            const authorization = new URL(notice.message.split("\n").at(-1) ?? "");
            const redirect = new URL(authorization.searchParams.get("redirect_uri") ?? "");
            redirect.searchParams.set("code", "fixture-code");
            redirect.searchParams.set("state", authorization.searchParams.get("state") ?? "");
            return redirect.href;
          },
        });
        runtimes.push(runtime);
        await runtime.prompt("/mcp", "prompt", []);
        await runtime.prompt("/mcp login oauth", "prompt", []);
        expect(inputs).toHaveLength(1);
        expect(intents).toContainEqual(
          expect.objectContaining({
            kind: "notify",
            message: expect.stringContaining(
              complete ? 'Signed in to MCP server "oauth"' : "Sign-in cancelled.",
            ),
          }),
        );
        expect(server.tokenRequests()).toBe(complete ? 1 : 0);
        const credentials = await readFile(join(agentDir, "mcp-auth.json"), "utf8");
        expect(credentials.includes("fixture-token")).toBe(complete);
        if (complete) {
          expect(await readFile(join(agentDir, "mcp.log"), "utf8")).toContain("MCP fixture log");
          await runtime.prompt("/mcp reconnect oauth", "prompt", []);
          await runtime.prompt("/mcp logout oauth", "prompt", []);
          expect(await readFile(join(agentDir, "mcp-auth.json"), "utf8")).not.toContain(
            "fixture-token",
          );
          expect(intents).toContainEqual(
            expect.objectContaining({
              kind: "notify",
              message: 'Signed out of MCP server "oauth".',
            }),
          );
        }
        await runtime.dispose();
      } finally {
        await server.close();
      }
    },
  );
  it("wires native commands and shares one awaited shutdown in the actual Cake runtime", async () => {
    const { cwd, agentDir } = await directoryFixture();
    await mkdir(join(agentDir, "extensions"));
    const trace = join(cwd, "shutdown.txt");
    await writeFile(
      join(agentDir, "extensions", "shutdown.ts"),
      `import { appendFile } from 'node:fs/promises'; export default (pi) => { pi.on('session_shutdown', async (event, ctx) => { await appendFile(${JSON.stringify(trace)}, event.reason + ':' + ctx.cwd + '\\n'); }); };`,
    );
    const intents: ExtensionUiIntent[] = [];
    const runtime = await createCakeSessionRuntime({
      cwd,
      agentDir,
      trusted: true,
      sessionDir: join(cwd, "sessions"),
      newSession: true,
      requestUi: async () => undefined,
      emitExtensionUiIntent: (intent) => intents.push(intent),
      onEvent: () => {},
    });
    runtimes.push(runtime);
    expect((await runtime.snapshot()).commands.some((command) => command.name === "mcp")).toBe(
      true,
    );
    await runtime.prompt("/mcp", "prompt", []);
    expect(intents).toContainEqual(expect.objectContaining({ kind: "notify" }));
    const first = runtime.dispose();
    const second = runtime.dispose();
    expect(second).toBe(first);
    await first;
    expect(await readFile(trace, "utf8")).toBe(`quit:${cwd}\n`);
  });
});
