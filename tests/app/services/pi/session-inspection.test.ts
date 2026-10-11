import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { inspectSessionHistory } from "../../../../src/services/pi/runtime/session-inspection";
import { appendToolCompactedBranch } from "../../../../src/services/pi/runtime/session-tool-compaction";
import { toolCompactEntryType } from "../../../../src/services/pi/runtime/tool-compaction-provenance";
import {
  SessionHistoryQuery,
  QueuedSessionCommand,
} from "../../../../src/contracts/conversations/session-query-data";

function assistant(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "test",
    stopReason: "stop",
    timestamp: 1,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function history() {
  const session = SessionManager.inMemory("/project");
  session.appendMessage({ role: "user", content: "Run verification", timestamp: 1 });
  session.appendMessage(
    assistant([
      { type: "toolCall", id: "tests", name: "bash", arguments: { command: "pnpm test" } },
    ]),
  );
  const resultId = session.appendMessage({
    role: "toolResult",
    toolName: "bash",
    toolCallId: "tests",
    isError: true,
    content: [{ type: "text", text: "x".repeat(200) + "regression failed" }],
    timestamp: 2,
  });
  const reportId = session.appendMessage(
    assistant([{ type: "text", text: "The regression failed; corrected it." }]),
  );
  return { session, resultId, reportId };
}

describe("session inspection", () => {
  it("combines text, role, type, tool and time filters before pagination and clipping", () => {
    const { session, resultId } = history();
    const timestamp = session.getEntry(resultId)!.timestamp;
    const input = Schema.decodeUnknownSync(SessionHistoryQuery)({
      query: "regression",
      roles: ["toolResult"],
      types: ["message"],
      toolName: "bash",
      after: timestamp,
      before: timestamp,
      limit: 1,
      maxChars: 20,
    });
    expect(inspectSessionHistory(session, input)).toMatchObject({
      total: 1,
      nextOffset: null,
      entries: [
        {
          entryId: resultId,
          role: "toolResult",
          isError: true,
          text: "x".repeat(20),
          truncated: true,
          tools: [{ name: "bash", callId: "tests" }],
        },
      ],
    });
    expect(inspectSessionHistory(session, { ...input, roles: ["assistant"] })).toMatchObject({
      total: 0,
      entries: [],
    });
    expect(inspectSessionHistory(session, { ...input, toolName: "read" })).toMatchObject({
      total: 0,
    });
  });

  it("paginates matched entries chronologically and searches tool-call arguments", () => {
    const { session } = history();
    expect(inspectSessionHistory(session, { toolName: "bash", limit: 1 })).toMatchObject({
      total: 2,
      offset: 0,
      nextOffset: 1,
      entries: [{ role: "assistant" }],
    });
    expect(inspectSessionHistory(session, { toolName: "bash", limit: 1, offset: 1 })).toMatchObject(
      { total: 2, nextOffset: null, entries: [{ role: "toolResult" }] },
    );
    expect(inspectSessionHistory(session, { query: "pnpm test", toolName: "bash" })).toMatchObject({
      total: 1,
      entries: [{ role: "assistant", tools: [{ arguments: '{"command":"pnpm test"}' }] }],
    });
  });

  it("distinguishes current tool-compacted branches from past compaction elsewhere and retrieves original tools", () => {
    const { session, reportId } = history();
    expect(
      inspectSessionHistory(session, { branch: "all", types: ["tool-compaction"] }),
    ).toMatchObject({ total: 0 });
    const compacted = appendToolCompactedBranch(session, reportId);
    expect(inspectSessionHistory(session, { types: ["tool-compaction"] })).toMatchObject({
      total: 1,
      entries: [
        {
          active: true,
          customType: toolCompactEntryType,
          text: expect.stringContaining("tool-compacted continuation"),
          sourceLeafId: reportId,
          replayedMessages: 2,
        },
      ],
    });
    expect(inspectSessionHistory(session, { toolName: "bash" })).toMatchObject({ total: 0 });
    expect(inspectSessionHistory(session, { leafId: reportId, toolName: "bash" })).toMatchObject({
      total: 2,
      entries: [{ active: false }, { active: false }],
    });
    session.branch(reportId);
    expect(inspectSessionHistory(session, { types: ["tool-compaction"] })).toMatchObject({
      total: 0,
    });
    expect(
      inspectSessionHistory(session, { branch: "all", types: ["tool-compaction"] }),
    ).toMatchObject({ total: 1, entries: [{ active: false, sourceLeafId: reportId }] });
    expect(
      inspectSessionHistory(session, { leafId: compacted.leafId, types: ["tool-compaction"] }),
    ).toMatchObject({ total: 1 });
  });

  it("includes normal compaction evidence without exposing hidden custom extension payloads", () => {
    const { session, reportId } = history();
    session.appendCompaction("Preserved verification decisions", reportId, 10_000);
    session.appendCustomEntry("extension.private", {
      summary: "Private extension summary",
      secret: "not transcript content",
    });
    expect(inspectSessionHistory(session, { types: ["compaction"] })).toMatchObject({
      entries: [
        {
          text: "Preserved verification decisions",
          tokensBefore: 10_000,
          firstKeptEntryId: reportId,
        },
      ],
    });
    expect(inspectSessionHistory(session, { query: "not transcript content" })).toMatchObject({
      total: 0,
    });
    expect(inspectSessionHistory(session, { query: "Private extension summary" })).toMatchObject({
      total: 0,
    });
    expect(inspectSessionHistory(session, { types: ["custom"] })).toMatchObject({
      total: 1,
      entries: [{ customType: "extension.private", text: "extension.private" }],
    });
    expect(inspectSessionHistory(session, { types: ["tool-compaction"] })).toMatchObject({
      total: 0,
    });
  });

  it.each([
    { name: "missing summary", data: { secret: "hidden marker payload" } },
    { name: "non-text summary", data: { summary: 42, secret: "hidden marker payload" } },
    {
      name: "invalid checkpoint ID",
      data: { summary: "hidden marker payload", systemCheckpointEntryId: "" },
    },
  ])("keeps a malformed Tool Compact marker hidden ($name)", ({ data }) => {
    const { session } = history();
    session.appendCustomEntry(toolCompactEntryType, data);
    expect(inspectSessionHistory(session, { types: ["tool-compaction"] })).toMatchObject({
      total: 0,
    });
    expect(inspectSessionHistory(session, { query: "hidden marker payload" })).toMatchObject({
      total: 0,
    });
    expect(inspectSessionHistory(session, { types: ["custom"] })).toMatchObject({
      total: 1,
      entries: [{ customType: toolCompactEntryType, text: toolCompactEntryType }],
    });
  });

  it("rejects nonexistent or ambiguous branch requests and invalid filter ranges", () => {
    const { session, reportId } = history();
    expect(() => inspectSessionHistory(session, { leafId: "missing" })).toThrow("does not exist");
    expect(() => inspectSessionHistory(session, { leafId: reportId, branch: "all" })).toThrow(
      "cannot be combined",
    );
    expect(() =>
      inspectSessionHistory(session, {
        after: "2026-01-02T00:00:00Z",
        before: "2026-01-01T00:00:00Z",
      }),
    ).toThrow("after must not");
    expect(() => Schema.decodeUnknownSync(SessionHistoryQuery)({ limit: 1_000 })).toThrow();
    expect(() => Schema.decodeUnknownSync(QueuedSessionCommand)({ command: "compact" })).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(QueuedSessionCommand)({ command: "/compact\nsecond command" }),
    ).toThrow();
  });
});
