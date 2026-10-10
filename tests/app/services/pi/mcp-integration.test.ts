import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import type {
  McpExtensionOptions,
  CodemodeExtensionOptions,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

const factories = vi.hoisted(() => ({
  mcp: vi.fn<(options: McpExtensionOptions) => ExtensionFactory>(() => vi.fn()),
  codemode: vi.fn<(options: CodemodeExtensionOptions) => ExtensionFactory>(() => vi.fn()),
  search: vi.fn(() => vi.fn()),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createMcpExtension: factories.mcp,
  createCodemodeExtension: factories.codemode,
  createToolSearchExtension: factories.search,
  getAgentDir: () => process.env.PI_CODING_AGENT_DIR,
}));
import {
  createCakeMcpExtensions,
  type CakeMcpIntegrationOptions,
} from "../../../../src/services/pi/runtime/mcp-integration";

const runtime: CakeMcpIntegrationOptions["runtime"] = { agentDir: resolve("fixture-agent") };
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
function bootstrap() {
  vi.stubEnv("PI_CODING_AGENT_DIR", runtime.agentDir);
}

describe("Cake native MCP integration contract", () => {
  it("rejects mismatched roots before constructing extensions", () => {
    vi.stubEnv("PI_CODING_AGENT_DIR", "another-root");
    expect(() => createCakeMcpExtensions({ runtime })).toThrow("global agent directory");
    expect(factories.mcp).not.toHaveBeenCalled();
  });
  it("supplies named builtin replaceable factories without mutating the tool selection", () => {
    bootstrap();
    const extensions = createCakeMcpExtensions({ runtime });
    expect(extensions).toEqual([
      { name: "codemode", builtin: true, replaceable: true, factory: expect.any(Function) },
      { name: "tool-search", builtin: true, replaceable: true, factory: expect.any(Function) },
      { name: "mcp", builtin: true, replaceable: true, factory: expect.any(Function) },
    ]);
    expect(runtime.tools).toBeUndefined();
    expect(factories.codemode).toHaveBeenCalledWith({ mode: "on" });
    expect(factories.search).toHaveBeenCalledWith();
  });
  it.each([
    { auxiliary: true },
    { globalControl: { tools: [], invoke: async () => ({ ok: true }) } },
    { tools: ["read"] },
    { tools: [] },
  ])("omits native factories from restricted runtimes: %j", (restriction) => {
    expect(createCakeMcpExtensions({ runtime: { ...runtime, ...restriction } })).toEqual([]);
    expect(factories.mcp).not.toHaveBeenCalled();
  });
  it("forwards controlled test boundaries and suppresses backend browser opening", () => {
    bootstrap();
    const loadConfig = vi.fn(() => ({ servers: [], errors: [] }));
    createCakeMcpExtensions({ runtime, loadConfig });
    expect(factories.mcp).toHaveBeenCalledWith({
      loadConfig,
      createTransport: undefined,
      openUrl: expect.any(Function),
    });
    // Calling the supplied opener has no side effects and does not throw.
    const options = factories.mcp.mock.calls[0]?.[0];
    options?.openUrl?.("https://example.com/authorize");
  });
});
