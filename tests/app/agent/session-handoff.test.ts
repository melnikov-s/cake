import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createConversationHandoff } from "../../../src/services/pi/runtime/session-handoff";

const usage: Usage = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
};

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-test",
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("createConversationHandoff", () => {
  it("copies visible dialogue through the selected response without tool history", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "cake-handoff-"));
    temporaryDirectories.push(sessionDir);
    const source = SessionManager.create("/project", sessionDir);
    source.appendMessage({ role: "user", content: "Investigate this", timestamp: 1 });
    source.appendMessage(
      assistant([
        { type: "text", text: "I will inspect it." },
        { type: "thinking", thinking: "private analysis" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "large.ts" } },
      ]),
    );
    source.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "very large tool result" }],
      isError: false,
      timestamp: 2,
    });
    const selectedId = source.appendMessage(
      assistant([{ type: "text", text: "The investigation report." }]),
    );
    source.appendMessage({ role: "user", content: "Unrelated tangent", timestamp: 3 });
    source.appendMessage(assistant([{ type: "text", text: "Later response" }]));

    const result = createConversationHandoff(source, selectedId);
    const handedOff = SessionManager.open(result.sessionFile, sessionDir, "/project");
    const entries = handedOff.getBranch();
    const messages = entries.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));

    const serializedContent = messages
      .flatMap((message) => ("content" in message ? [JSON.stringify(message.content)] : []))
      .join("\n");
    expect(handedOff.getHeader()?.parentSession).toBe(source.getSessionFile());
    // The orientation preamble is the first entry, before any copied dialogue.
    expect(entries[0]).toMatchObject({
      type: "custom_message",
      customType: "cake.handoff/v1",
      display: true,
    });
    const preamble =
      entries[0]?.type === "custom_message" && typeof entries[0].content === "string"
        ? entries[0].content
        : "";
    expect(preamble).toContain(source.getSessionFile());
    expect(preamble).toContain("2 tool calls and results were omitted");
    expect(preamble).toContain("verify the current state on disk");
    const context = handedOff.buildSessionContext();
    expect(JSON.stringify(context.messages[0])).toContain("handoff from a previous Cake session");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(messages).not.toContainEqual(expect.objectContaining({ role: "toolResult" }));
    expect(serializedContent).not.toContain("toolCall");
    expect(serializedContent).not.toContain("private analysis");
    expect(serializedContent).not.toContain("Unrelated tangent");
    expect(messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "The investigation report." }],
      usage: { input: 0, output: 0, totalTokens: 0 },
    });
  });

  it("omits the orientation preamble when no tool activity was elided", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "cake-handoff-"));
    temporaryDirectories.push(sessionDir);
    const source = SessionManager.create("/project", sessionDir);
    source.appendMessage({ role: "user", content: "Hello", timestamp: 1 });
    const selectedId = source.appendMessage(assistant([{ type: "text", text: "Plain answer" }]));

    const result = createConversationHandoff(source, selectedId);
    const handedOff = SessionManager.open(result.sessionFile, sessionDir, "/project");
    expect(handedOff.getBranch()).toHaveLength(2);
    expect(
      handedOff
        .getBranch()
        .some((entry) => entry.type === "custom_message" && entry.customType === "cake.handoff/v1"),
    ).toBe(false);
  });

  it("rejects non-assistant handoff targets", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "cake-handoff-"));
    temporaryDirectories.push(sessionDir);
    const source = SessionManager.create("/project", sessionDir);
    const userId = source.appendMessage({ role: "user", content: "Question", timestamp: 1 });

    expect(() => createConversationHandoff(source, userId)).toThrow(
      "Handoff requires a completed assistant response",
    );
  });
});
