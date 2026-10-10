import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  getAgentDir,
  type McpExtensionOptions,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import type { CakeSessionRuntimeOptions } from "./cake-session-runtime";

/**
 * Pi owns MCP configuration, credentials, connections, tools, and commands.
 */
export interface CakeMcpIntegrationOptions {
  readonly runtime: Pick<
    CakeSessionRuntimeOptions,
    "agentDir" | "auxiliary" | "globalControl" | "tools"
  >;
  /** Test boundary only; production uses Pi's standard configuration loader. */
  readonly loadConfig?: McpExtensionOptions["loadConfig"];
  /** Test boundary only; production uses Pi's stdio/streamable-HTTP transports. */
  readonly createTransport?: McpExtensionOptions["createTransport"];
}

/**
 * Supplies named, builtin, replaceable MCP/tool-search/codemode factories only
 * for primary Project Session runtimes without a fixed tool allowlist.
 * Restricted runtimes receive no factories, even when personal MCP config exists.
 *
 * Production requires Pi's global agent directory to match runtime.agentDir;
 * a mismatch rejects initialization rather than using another credential root.
 * Builtin metadata preserves Pi's disable and replacement-extension behavior.
 *
 * Tools start inactive. Pi configuration controls discovery activation; configuring
 * codemode exposure is an opt-in to scripting. Use mode "on", never "only".
 * Do not replace the session's existing tools/defaultTools selection.
 *
 * First slice uses Pi's RPC-mode /mcp status/login/logout/reconnect commands.
 * Override Pi's browser opener with a no-op: authorization URLs remain visible
 * through Pi's notification, and redirect-URL input uses Cake's existing UI.
 * Automatic native URL opening and a structured connection screen are deferred.
 */
export function createCakeMcpExtensions(options: CakeMcpIntegrationOptions) {
  const { runtime } = options;
  if (runtime.auxiliary || runtime.globalControl || runtime.tools !== undefined) return [];
  if (resolve(getAgentDir()) !== resolve(runtime.agentDir))
    throw new Error("Pi's global agent directory must match Cake's backend agent directory");
  return [
    {
      name: "codemode",
      builtin: true,
      replaceable: true,
      factory: createCodemodeExtension({ mode: "on" }),
    },
    {
      name: "tool-search",
      builtin: true,
      replaceable: true,
      factory: createToolSearchExtension(),
    },
    {
      name: "mcp",
      builtin: true,
      replaceable: true,
      factory: createMcpExtension({
        loadConfig: options.loadConfig,
        createTransport: options.createTransport,
        // Pi notifies the authorization URL; never spawn a browser on the backend.
        openUrl: () => {},
      }),
    },
  ];
}
