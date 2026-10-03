import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Schema } from "effect";

const requestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  method: Schema.String,
});

/** Loopback-only MCP/OAuth boundary used by real Pi and Electron contract tests. */
export async function startMcpServer() {
  let base = "";
  let calls = 0;
  let tokenRequests = 0;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", base);
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${base}/mcp`, authorization_servers: [base] });
      return;
    }
    if (url.pathname.startsWith("/.well-known/oauth-authorization-server")) {
      json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
      });
      return;
    }
    if (url.pathname === "/register") {
      json({ client_id: "fixture-client", token_endpoint_auth_method: "none" }, 201);
      return;
    }
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? base);
      redirect.searchParams.set("code", "fixture-code");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.writeHead(302, { location: redirect.href });
      response.end();
      return;
    }
    if (url.pathname === "/token") {
      tokenRequests += 1;
      json({
        access_token: "fixture-token",
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
        expires_in: 3600,
      });
      return;
    }
    if (url.pathname !== "/mcp") {
      json({ error: "not found" }, 404);
      return;
    }
    if (request.headers.authorization !== "Bearer fixture-token") {
      response.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
      );
      json({ error: "Sign-in required" }, 401);
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const message = Schema.decodeUnknownSync(requestSchema)(JSON.parse(body));
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    let result: unknown;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "oauth-fixture", version: "1" },
        };
        break;
      case "tools/list":
        result = {
          tools: [
            { name: "echo", description: "Echo", inputSchema: { type: "object", properties: {} } },
          ],
        };
        break;
      case "tools/call":
        calls += 1;
        result = { content: [{ type: "text", text: "OAuth MCP result" }] };
        break;
      default:
        json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "Unknown method" },
        });
        return;
    }
    if (message.method === "tools/list") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "MCP fixture log" } })}\n\n`,
      );
      response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`);
    } else json({ jsonrpc: "2.0", id: message.id, result });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${base}/mcp`,
    calls: () => calls,
    tokenRequests: () => tokenRequests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
