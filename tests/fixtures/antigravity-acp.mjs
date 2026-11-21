#!/usr/bin/env node
// ACP v1 fixture. No model, network, auth, terminal, or tools are actually run.
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] !== "acp") process.exit(64);
const auth = existsSync("fixture-auth-required");
const resume = !existsSync("fixture-no-resume");
let sessionId;
let promptId;
let needsPermission = false;
const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
const answer = (id, result) => send({ id, result });
const update = (sessionUpdate, content, id = sessionId) =>
  send({
    method: "session/update",
    params: { sessionId: id, update: { sessionUpdate, ...content } },
  });
const text = (text, id) => update("agent_message_chunk", { content: { type: "text", text } }, id);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync("fixture-acp-wire.ndjson", line + "\n");
  switch (request.method) {
    case "initialize":
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
        answer(request.id, { sessionId });
      }
      break;
    case "session/resume":
      if (!resume || existsSync("fixture-reject-resume")) {
        send({ id: request.id, error: { code: -32601, message: "resume unavailable" } });
        break;
      }
      sessionId = request.params.sessionId;
      text("DO NOT SHOW SETUP REPLAY");
      answer(request.id, {});
      break;
    case "session/prompt": {
      promptId = request.id;
      const first = request.params.prompt[0].text;
      text("DO NOT SHOW OTHER CHAT", "other-chat");
      text("ACP first chunk · café");
      if (first === "disconnect") process.exit(1);
      if (first === "hold before cancel") break;
      if (first.includes("permission")) {
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
