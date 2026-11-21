import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Schema } from "effect";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { toDraft07JsonSchema } from "../../contracts/serialization/json-contract";
import { cakeToolEnvelopeSchema } from "../../contracts/agent/cake-operation";

export type AcpCakeCall = (
  input: typeof cakeToolEnvelopeSchema.Type,
  context: { signal: AbortSignal; toolCallId: string },
) => Promise<{ text: string; isError?: boolean }>;

const maxBody = 64 * 1024;
const maxCalls = 128;
const host = "127.0.0.1";
const decodeEnvelope = Schema.decodeUnknownSync(cakeToolEnvelopeSchema, {
  onExcessProperty: "error",
});
const isBoundAddress = Schema.is(Schema.Struct({ port: Schema.Number }));

/** ACP session/new provisions this one loopback Streamable HTTP MCP server. The
 * credential is transport metadata (not a model argument) and dies with the ACP turn. */
export async function openAcpCakeMcp(call: AcpCakeCall, onDisconnect: () => void) {
  const lifetime = new AbortController();
  const auth = Buffer.from(`Bearer ${randomBytes(32).toString("base64url")}`);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  const mcp = new Server(
    { name: "Cake Project Chat", version: "1" },
    { capabilities: { tools: {} } },
  );
  const calls = new Set<string | number>();
  let listed = false;
  let active = false;
  let pending = false;
  mcp.setRequestHandler(ListToolsRequestSchema, async () => {
    listed = true;
    return {
      tools: [
        {
          name: "cake",
          description:
            "Run a scoped Cake Project Chat operation. Omit command for topics; use topic, operation.help, or operation.output-schema for discovery.",
          inputSchema: { ...toDraft07JsonSchema(cakeToolEnvelopeSchema), type: "object" },
        },
      ],
    };
  });
  mcp.setRequestHandler(CallToolRequestSchema, async ({ params }, { requestId, signal }) => {
    const error = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
    if (!active || lifetime.signal.aborted || signal.aborted) return error("No active Cake turn.");
    if (params.name !== "cake") return error("Unknown tool.");
    if (pending || calls.has(requestId) || calls.size >= maxCalls)
      return error("Cake calls must be sequential, unique, and within the per-turn call limit.");
    calls.add(requestId);
    pending = true;
    const bounded = AbortSignal.any([lifetime.signal, signal]);
    try {
      const { text, isError } = await call(decodeEnvelope(params.arguments ?? {}), {
        signal: bounded,
        toolCallId: randomUUID(),
      });
      bounded.throwIfAborted();
      return { content: [{ type: "text" as const, text }], isError };
    } catch (cause) {
      if (bounded.aborted) return error("Cake call canceled.");
      if (cause instanceof DOMException && cause.name === "TimeoutError")
        return error(
          "Cake call timed out. The operation may already have taken effect; inspect its state before retrying.",
        );
      return error(
        "Cake call failed; check the operation help or inspect Cake before retrying. Failure does not imply rollback.",
      );
    } finally {
      pending = false;
    }
  });

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000 }, (req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(400).end();
      else res.destroy();
    });
  });
  function close() {
    if (lifetime.signal.aborted) return;
    active = false;
    lifetime.abort();
    server.close();
    server.closeAllConnections();
    void mcp.close();
  }
  let authority = "";
  async function handle(req: IncomingMessage, res: ServerResponse) {
    const header = Buffer.from(req.headers.authorization ?? "");
    if (
      lifetime.signal.aborted ||
      req.url !== "/mcp" ||
      req.headers.host !== authority ||
      req.headers.origin !== undefined ||
      header.length !== auth.length ||
      !timingSafeEqual(header, auth)
    ) {
      res.writeHead(403).end();
      return;
    }
    // The bridge is request/response only: no server events, reconnect or replay.
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (req.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
      res.writeHead(415).end();
      return;
    }
    res.once("close", () => {
      if (!res.writableFinished && !lifetime.signal.aborted) {
        close();
        onDisconnect();
      }
    });
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBody) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(bytes);
    }
    if (lifetime.signal.aborted) return;
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (Array.isArray(body)) {
      res.writeHead(400).end();
      return;
    }
    await transport.handleRequest(req, res, body);
  }
  try {
    await mcp.connect(transport);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!isBoundAddress(address)) throw new Error("No MCP loopback address");
    authority = `${host}:${address.port}`;
    server.on("error", () => {
      close();
      onDisconnect();
    });
    return {
      config: {
        type: "http",
        name: "cake_project_chat",
        url: `http://${authority}/mcp`,
        headers: [{ name: "Authorization", value: auth.toString() }],
      },
      activate() {
        if (!listed || lifetime.signal.aborted) return false;
        active = true;
        return true;
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
