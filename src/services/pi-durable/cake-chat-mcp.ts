import type { McpServerConfig, RegisteredMcpServer } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-durable-ai";
import {
  McpAuthRequiredError,
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type McpTransport,
  type Tool as McpTool,
} from "@earendil-works/pi-mcp";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES,
  CAKE_CHAT_TOOL_OUTPUT_MAX_LINES,
} from "./cake-chat-local-tools";

/**
 * Cake Chat's MCP access (including the Tool Gateway): the same servers Pi sessions see, read
 * from the agent directory's `mcp.json` and from servers the agent directory's extensions
 * register. Pi's MCP extension binds only to coding-agent sessions, and Cake Chat runs on Pi
 * Durable, so this is a small client of its own: one `mcp` tool with progressive discovery
 * (servers → search → describe → call) that keeps hundreds of tool schemas out of the
 * permanent conversation's context. Header/command/env credentials work; OAuth sign-in does not.
 */
export interface CakeChatMcpServer {
  readonly name: string;
  readonly config: McpServerConfig;
}

const SEARCH_LIMIT = 25;
const DEFAULT_TIMEOUT_SECONDS = 60;

/** `mcp.json` entries win over extension registrations of the same name, as in Pi. */
export async function loadCakeChatMcpServers(options: {
  readonly agentDirectory: string;
  readonly registered: readonly RegisteredMcpServer[];
}): Promise<{ servers: CakeChatMcpServer[]; errors: string[] }> {
  const errors: string[] = [];
  const configured = new Map<string, McpServerConfig>();
  const path = join(options.agentDirectory, "mcp.json");
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const servers =
      typeof parsed === "object" && parsed !== null && "mcpServers" in parsed
        ? parsed.mcpServers
        : undefined;
    if (typeof servers === "object" && servers !== null)
      for (const [name, config] of Object.entries(servers)) {
        if (isServerConfig(config)) configured.set(name, config);
        else errors.push(`MCP server "${name}" in ${path} needs a url or command`);
      }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      errors.push(`Could not read ${path}: ${message(error)}`);
  }
  for (const server of options.registered)
    if (!configured.has(server.name)) configured.set(server.name, server.config);
  return {
    servers: [...configured]
      .filter(([, config]) => config.enabled !== false && config.exposure !== "hidden")
      .map(([name, config]) => ({ name, config })),
    errors,
  };
}

function isServerConfig(value: unknown): value is McpServerConfig {
  return (
    typeof value === "object" &&
    value !== null &&
    (("url" in value && typeof value.url === "string") ||
      ("command" in value && typeof value.command === "string"))
  );
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Pi's config-value convention: `!command` runs a shell command and uses its stdout;
 * otherwise `$NAME`/`${NAME}` interpolate environment variables, and `$$` is a literal `$`.
 */
export async function resolveMcpConfigValue(
  value: string,
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv } = { cwd: homedir() },
): Promise<string> {
  const env = options.env ?? process.env;
  if (value.startsWith("!"))
    return new Promise((resolvePromise, reject) => {
      execFile(
        "/bin/bash",
        ["-c", value.slice(1)],
        { cwd: options.cwd, env, timeout: 10_000, encoding: "utf8" },
        (error, stdout) => {
          if (error) reject(new Error(`Credential command failed: ${error.message}`));
          else resolvePromise(stdout.trim());
        },
      );
    });
  return value.replace(
    /\$(\$|!|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (match, escape: string, braced?: string, bare?: string) => {
      if (escape === "$" || escape === "!") return escape;
      const name = braced ?? bare;
      const resolved = name === undefined ? undefined : env[name];
      if (resolved === undefined || resolved === "")
        throw new Error(`Environment variable ${name} is not set`);
      return resolved;
    },
  );
}

/** Exposure overrides: exact names win over `*` patterns; the first matching pattern wins. */
function hiddenTool(config: McpServerConfig, tool: string) {
  const overrides = config.toolExposure ?? {};
  const exact = overrides[tool];
  const exposure =
    exact ??
    Object.entries(overrides).find(
      ([pattern]) =>
        pattern.includes("*") &&
        new RegExp(
          `^${pattern
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        ).test(tool),
    )?.[1] ??
    config.exposure;
  return exposure === "hidden";
}

export type CakeChatMcpTransportFactory = (
  server: CakeChatMcpServer,
  cwd: string,
) => Promise<McpTransport>;

async function defaultTransport(server: CakeChatMcpServer, cwd: string): Promise<McpTransport> {
  const { config } = server;
  const resolveValue = (value: string) => resolveMcpConfigValue(value, { cwd });
  const resolveRecord = async (record: Record<string, string> | undefined) =>
    Object.fromEntries(
      await Promise.all(
        Object.entries(record ?? {}).map(async ([key, value]) => [key, await resolveValue(value)]),
      ),
    );
  const expandHome = (value: string) =>
    value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if ("url" in config)
    return new StreamableHttpTransport({
      url: config.url,
      headers: await resolveRecord(config.headers),
    });
  return new StdioTransport({
    command: expandHome(config.command),
    args: config.args?.map(expandHome),
    cwd: resolve(cwd, expandHome(config.cwd ?? ".")),
    env: await resolveRecord(config.env),
    stderr: "pipe",
  });
}

interface Connection {
  readonly client: McpClient;
  readonly tools: readonly McpTool[];
}

export class CakeChatMcp {
  private readonly connections = new Map<string, Promise<Connection>>();
  private closed = false;

  constructor(
    private readonly servers: readonly CakeChatMcpServer[],
    private readonly options: {
      readonly cwd: string;
      readonly createTransport?: CakeChatMcpTransportFactory;
    },
  ) {}

  private server(name: string) {
    const server = this.servers.find((candidate) => candidate.name === name);
    if (!server)
      throw new Error(
        `Unknown MCP server "${name}". Available: ${this.servers.map((entry) => entry.name).join(", ") || "none"}.`,
      );
    return server;
  }

  private timeoutMs(server: CakeChatMcpServer) {
    return (server.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  }

  private connect(server: CakeChatMcpServer): Promise<Connection> {
    if (this.closed) return Promise.reject(new Error("Cake Chat MCP access has closed"));
    const existing = this.connections.get(server.name);
    if (existing) return existing;
    const connecting = (async () => {
      const client = new McpClient({
        name: "cake-chat",
        version: "1.0.0",
        requestTimeoutMs: this.timeoutMs(server),
      });
      try {
        await client.connect(
          await (this.options.createTransport ?? defaultTransport)(server, this.options.cwd),
        );
        const tools = (await client.listTools()).filter(
          (tool) => !hiddenTool(server.config, tool.name),
        );
        return { client, tools };
      } catch (error) {
        await client.close().catch(() => undefined);
        if (error instanceof McpAuthRequiredError)
          throw new Error(
            `MCP server "${server.name}" requires OAuth sign-in, which Cake Chat cannot perform. Sign in from a Project Session with /mcp, or delegate this lookup to a project subagent.`,
            { cause: error },
          );
        throw new Error(`Could not connect to MCP server "${server.name}": ${message(error)}`, {
          cause: error,
        });
      }
    })();
    this.connections.set(server.name, connecting);
    connecting
      .then(({ client }) =>
        client.onClose(() => {
          if (this.connections.get(server.name) === connecting)
            this.connections.delete(server.name);
        }),
      )
      .catch(() => {
        if (this.connections.get(server.name) === connecting) this.connections.delete(server.name);
      });
    return connecting;
  }

  list() {
    return this.servers.map((server) => ({
      server: server.name,
      ...(server.config.description ? { description: server.config.description } : null),
      transport: "url" in server.config ? "http" : "stdio",
    }));
  }

  async search(query: string | undefined, serverName: string | undefined) {
    const servers = serverName ? [this.server(serverName)] : this.servers;
    const terms = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const matches: Array<{ server: string; tool: string; description: string }> = [];
    const failures: string[] = [];
    await Promise.all(
      servers.map(async (server) => {
        try {
          const { tools } = await this.connect(server);
          for (const tool of tools) {
            const haystack =
              `${tool.name} ${tool.title ?? ""} ${tool.description ?? ""}`.toLowerCase();
            if (terms.every((term) => haystack.includes(term)))
              matches.push({
                server: server.name,
                tool: tool.name,
                description: (tool.description ?? tool.title ?? "").split("\n")[0]!.slice(0, 200),
              });
          }
        } catch (error) {
          failures.push(message(error));
        }
      }),
    );
    return {
      total: matches.length,
      matches: matches.slice(0, SEARCH_LIMIT),
      ...(matches.length > SEARCH_LIMIT ? { note: "Narrow the query to see more." } : null),
      ...(failures.length ? { failures } : null),
    };
  }

  private async tool(serverName: string, toolName: string) {
    const server = this.server(serverName);
    const connection = await this.connect(server);
    const tool = connection.tools.find((candidate) => candidate.name === toolName);
    if (!tool)
      throw new Error(
        `MCP server "${serverName}" has no tool "${toolName}". Use action "search" to find tools.`,
      );
    return { server, connection, tool };
  }

  async describe(serverName: string, toolName: string) {
    const { tool } = await this.tool(serverName, toolName);
    return {
      server: serverName,
      tool: tool.name,
      description: tool.description ?? tool.title ?? "",
      inputSchema: tool.inputSchema,
    };
  }

  async call(
    serverName: string,
    toolName: string,
    args: Parameters<McpClient["callTool"]>[1],
    signal: AbortSignal | undefined,
  ) {
    const { server, connection } = await this.tool(serverName, toolName);
    const result = await connection.client.callTool(toolName, args ?? {}, {
      signal,
      timeoutMs: this.timeoutMs(server),
    });
    return { content: toLlmContent(result), isError: result.isError === true };
  }

  async close() {
    this.closed = true;
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(
      connections.map((connection) =>
        connection.then(({ client }) => client.close()).catch(() => undefined),
      ),
    );
  }
}

const json = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];

export function createCakeChatMcpTool(mcp: CakeChatMcp) {
  return defineTool({
    name: "mcp",
    description:
      'Call MCP servers such as the Tool Gateway (Slack, Vault, and other company tools). Discover progressively: {"action":"servers"}, then {"action":"search","query":"slack search"} (optionally with server), then {"action":"describe","server":…,"tool":…} for the input schema, then {"action":"call","server":…,"tool":…,"arguments":{…}}. For a single quick lookup only; delegate multi-step research.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("servers"),
        Type.Literal("search"),
        Type.Literal("describe"),
        Type.Literal("call"),
      ]),
      server: Type.Optional(Type.String({ description: "MCP server name from servers" })),
      query: Type.Optional(
        Type.String({
          description: "search: words that must all appear in a tool's name or description",
        }),
      ),
      tool: Type.Optional(Type.String({ description: "describe/call: exact tool name" })),
      arguments: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), { description: "call: tool arguments" }),
      ),
    }),
    replay: "unsafe",
    outputLimits: {
      maxBytes: CAKE_CHAT_TOOL_OUTPUT_MAX_BYTES,
      maxLines: CAKE_CHAT_TOOL_OUTPUT_MAX_LINES,
      retain: "head",
    },
    async execute(args, _api, context) {
      const required = (field: "server" | "tool") => {
        const value = args[field];
        if (!value) throw new Error(`mcp action "${args.action}" requires "${field}"`);
        return value;
      };
      switch (args.action) {
        case "servers":
          return { content: json(mcp.list()) };
        case "search":
          return { content: json(await mcp.search(args.query, args.server)) };
        case "describe":
          return { content: json(await mcp.describe(required("server"), required("tool"))) };
        case "call": {
          const result = await mcp.call(
            required("server"),
            required("tool"),
            args.arguments,
            context.abortSignal,
          );
          return { content: result.content, isError: result.isError };
        }
      }
    },
  });
}
