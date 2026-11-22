#!/usr/bin/env node
// ACP v1 fixture. Uses real loopback HTTP MCP when Cake provisions it; no model or external network.
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

if (process.argv[2] !== "acp") process.exit(64);
const discovery = process.argv.includes("--include-default-customizations=false");
const bin = dirname(process.argv[1]);
const wire =
  discovery && existsSync(join(bin, "fixture-record-discovery"))
    ? join(bin, "discovery.ndjson")
    : (process.env.CAKE_FIXTURE_WIRE ?? "fixture-acp-wire.ndjson");
const auth =
  existsSync("fixture-auth-required") ||
  (discovery && existsSync(join(bin, "fixture-discovery-auth-required")));
const catalog = () => ({
  models: {
    currentModelId: "fixture-default",
    availableModels: [
      { modelId: "fixture-sonnet-medium", name: "Fixture Sonnet (Medium)" },
      { modelId: "fixture-sonnet-high", name: "Fixture Sonnet (High)" },
      ...(existsSync(join(bin, "fixture-new-discovery-model"))
        ? [{ modelId: "fixture-flash", name: "Fixture Flash" }]
        : []),
    ],
  },
});
const resume = !existsSync("fixture-no-resume");
let sessionId;
let promptId;
let needsPermission = false;
let mcp;
let mcpSession;
let mcpId = 0;
const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
const answer = (id, result) => send({ id, result });
const update = (sessionUpdate, content, id = sessionId) =>
  send({
    method: "session/update",
    params: { sessionId: id, update: { sessionUpdate, ...content } },
  });
const text = (text, id) => update("agent_message_chunk", { content: { type: "text", text } }, id);
async function mcpRequest(method, params, overrides = {}) {
  const headers = Object.fromEntries(mcp.headers.map(({ name, value }) => [name, value]));
  const id = method.startsWith("notifications/") ? {} : { id: ++mcpId };
  const response = await fetch(mcp.url, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(mcpSession ? { "Mcp-Session-Id": mcpSession } : {}),
      ...overrides.headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", ...id, method, params }),
    signal: overrides.signal,
  });
  if (method === "initialize") mcpSession = response.headers.get("Mcp-Session-Id");
  const raw = await response.text();
  let payload;
  if (raw) payload = JSON.parse(raw);
  return { status: response.status, result: payload?.result };
}
const cake = (args, overrides) =>
  mcpRequest("tools/call", { name: "cake", arguments: args }, overrides);
const evidence = (contents) =>
  appendFileSync("fixture-mcp-evidence.ndjson", JSON.stringify(contents) + "\n");
async function discoverMcp() {
  await mcpRequest("server/discover", {});
  await mcpRequest("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "fake-agy", version: "1" },
  });
  await mcpRequest("notifications/initialized");
  const discovered = await mcpRequest("tools/list", {});
  const beforePrompt = await cake({ command: "todos.create", input: { title: "not active" } });
  const unauthorized = await cake({}, { headers: { Authorization: "Bearer not-the-turn-token" } });
  const wrongSession = await cake({}, { headers: { "Mcp-Session-Id": "wrong-session" } });
  evidence({ discovered, beforePrompt, unauthorized, wrongSession });
}
async function sendMcpResult(id, commands) {
  const findings = [];
  for (const command of commands) {
    const reply = await cake(command);
    appendFileSync("fixture-mcp-replies.ndjson", JSON.stringify(reply) + "\n");
    findings.push(reply);
  }
  evidence({ findings });
  text(findings.map(({ result }) => result?.content[0]?.text).join("\n"));
  answer(id, { stopReason: "end_turn" });
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(wire, line + "\n");
  switch (request.method) {
    case "initialize":
      if (process.env.CAKE_FIXTURE_HOLD_INITIALIZE) {
        process.stderr.write("holding initialize\n");
        break;
      }
      answer(request.id, {
        protocolVersion: existsSync("fixture-wrong-version") ? 9 : 1,
        agentInfo: { name: "agy", title: "Antigravity ACP Server", version: "0.0.0-fixture" },
        agentCapabilities: { sessionCapabilities: resume ? { resume: {} } : {} },
      });
      break;
    case "session/new":
      if (auth)
        send({
          id: request.id,
          error: { code: -32000, message: "Auth required; secret=not-for-client-logs" },
        });
      else {
        sessionId = `fixture-session-${process.pid}`;
        mcp = request.params.mcpServers[0];
        if (mcp && !existsSync("fixture-ignore-mcp")) await discoverMcp();
        answer(request.id, { sessionId, ...catalog() });
      }
      break;
    case "session/resume":
      if (!resume || existsSync("fixture-reject-resume")) {
        send({ id: request.id, error: { code: -32601, message: "resume unavailable" } });
        break;
      }
      sessionId = request.params.sessionId;
      text("DO NOT SHOW SETUP REPLAY");
      answer(request.id, catalog());
      break;
    case "session/set_config_option": {
      if (existsSync("fixture-reject-model")) {
        send({ id: request.id, error: { code: -32602, message: "unsupported selection" } });
        break;
      }
      const [, effort] = /fixture-sonnet-(.+)/.exec(request.params.value) ?? [];
      answer(request.id, {
        configOptions: [
          {
            id: "model",
            category: "model",
            type: "select",
            currentValue: effort ? "fixture-sonnet" : request.params.value,
          },
          ...(effort
            ? [
                {
                  id: "thought_level",
                  type: "select",
                  currentValue: existsSync("fixture-mismatch-model") ? "wrong-effort" : effort,
                },
              ]
            : []),
        ],
      });
      break;
    }
    case "session/prompt": {
      promptId = request.id;
      const first = request.params.prompt.at(-1).text;
      text("DO NOT SHOW OTHER CHAT", "other-chat");
      text("ACP first chunk · café");
      if (first === "disconnect") process.exit(1);
      if (first === "hold before cancel") break;
      if (mcp && first.startsWith("fixture Cake ")) {
        const commands = JSON.parse(first.slice("fixture Cake ".length));
        void sendMcpResult(promptId, commands).catch(() => undefined);
      } else if (first.includes("permission")) {
        needsPermission = true;
        update("tool_call", {
          toolCallId: "tool-1",
          title: "Inspect fixture",
          kind: "execute",
          status: "pending",
          rawInput: { command: "echo fixture-only" },
        });
        send({
          id: "permission",
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "tool-1" },
            options: [
              { kind: "allow_once", name: "Allow once", optionId: "yes" },
              { kind: "reject_once", name: "Deny", optionId: "no" },
              { kind: "allow_always", name: "Always", optionId: "never-chosen" },
            ],
          },
        });
      } else {
        text(" + final chunk");
        answer(promptId, { stopReason: "end_turn" });
        text("DO NOT SHOW LATE CHUNK");
      }
      break;
    }
    case "session/cancel":
      text("DO NOT SHOW AFTER CANCEL");
      // Send the prompt response after the permission cancellation arrives.
      if (!needsPermission) answer(promptId, { stopReason: "cancelled" });
      break;
    default:
      if (request.id === "permission") {
        if (request.result.outcome.outcome === "cancelled") {
          answer(promptId, { stopReason: "cancelled" });
        } else {
          const allowed = request.result.outcome.optionId === "yes";
          update("tool_call_update", {
            toolCallId: "tool-1",
            status: allowed ? "completed" : "failed",
          });
          text(allowed ? "Allowed fixture reply" : "Denied fixture reply");
          answer(promptId, { stopReason: "end_turn" });
        }
      }
  }
}
