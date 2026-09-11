import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { appendToolCompactedBranch } from "../../../src/services/pi/runtime/session-tool-compaction";

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

describe("tool compaction", () => {
  it("adds a clean root branch while preserving the Session ID and original tree", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "cake-tool-compact-"));
    temporaryDirectories.push(sessionDir);
    const session = SessionManager.create("/project", sessionDir);
    const originalUserId = session.appendMessage({
      role: "user",
      content: "Investigate this",
      timestamp: 1,
    });
    session.appendMessage(
      assistant([
        { type: "text", text: "I will inspect it." },
        { type: "thinking", thinking: "private analysis" },
        { type: "toolCall", id: "call-1", name: "read", arguments: { path: "large.ts" } },
      ]),
    );
    session.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "text", text: "large result" }],
      isError: false,
      timestamp: 2,
    });
    const selectedId = session.appendMessage(
      assistant([{ type: "text", text: "The investigation report." }]),
    );
    const originalSessionId = session.getSessionId();
    const originalSessionFile = session.getSessionFile();

    const result = appendToolCompactedBranch(session, selectedId, {
      provider: "openai",
      modelId: "gpt-test",
      thinkingLevel: "high",
    });

    expect(result).toMatchObject({
      sessionId: originalSessionId,
      sessionFile: originalSessionFile,
    });
    expect(session.getTree()).toHaveLength(2);
    expect(session.getTree()[0]?.entry.id).toBe(originalUserId);
    const activeBranch = session.getBranch();
    expect(activeBranch[0]).toMatchObject({
      type: "custom_message",
      customType: "cake.tool-compact/v1",
      parentId: null,
    });
    const context = session.buildSessionContext();
    expect(JSON.stringify(context.messages)).not.toContain("toolCall");
    expect(JSON.stringify(context.messages)).not.toContain("large result");
    expect(JSON.stringify(context.messages)).not.toContain("private analysis");
    expect(context.model).toEqual({ provider: "openai", modelId: "gpt-test" });
    expect(context.thinkingLevel).toBe("high");
    expect(
      activeBranch[0]?.type === "custom_message" ? activeBranch[0].content : undefined,
    ).toContain("full original transcript remains available in the session tree");
  });

  it("rejects non-assistant targets", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "cake-tool-compact-"));
    temporaryDirectories.push(sessionDir);
    const session = SessionManager.create("/project", sessionDir);
    const userId = session.appendMessage({ role: "user", content: "Question", timestamp: 1 });

    expect(() => appendToolCompactedBranch(session, userId)).toThrow(
      "Tool compaction requires a completed assistant response",
    );
  });
});
