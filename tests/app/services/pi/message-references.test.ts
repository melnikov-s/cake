import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MessageListInput,
  MessageListResult,
  MessageReadInput,
  MessageReadResult,
  MessageReference,
  messageNavigationTarget,
  messageReference,
  parseSessionLink,
} from "../../../../src/contracts/conversations/message-reference";
import {
  listMessageReferences,
  readMessageReference,
} from "../../../../src/services/pi/runtime/message-references";
import { appendToolCompactedBranch } from "../../../../src/services/pi/runtime/session-tool-compaction";

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "test",
    stopReason: "stop",
    timestamp: 2,
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

const input = {
  kind: "input" as const,
  id: "00000000-0000-4000-8000-000000000001",
  name: "requirements.txt",
  mimeType: "text/plain",
  byteLength: 500,
};

function fixture() {
  const session = SessionManager.inMemory("/project");
  const firstId = session.appendMessage({
    role: "user",
    content: `Private user content\n<cake-task-input>${JSON.stringify(input)}</cake-task-input>`,
    timestamp: 1,
  });
  session.appendMessage({
    role: "toolResult",
    toolName: "read",
    toolCallId: "tool-1",
    content: [{ type: "text", text: "Original tool evidence" }],
    isError: false,
    timestamp: 2,
  });
  const lastId = session.appendMessage(assistant("Exact assistant content"));
  return { session, firstId, lastId };
}

describe("exact message references", () => {
  it("lists bounded metadata and attachment inputRefs without body previews or attachment bytes", () => {
    const { session, firstId } = fixture();
    const result = listMessageReferences(session, { limit: 1 });
    expect(Schema.decodeUnknownSync(MessageListResult)(result)).toEqual(result);
    expect(result).toMatchObject({
      total: 3,
      nextOffset: 1,
      messages: [{ entryId: firstId, inputRefs: [input], role: "user", active: true }],
    });
    const ref = messageReference(session.getSessionId(), firstId);
    expect(result.messages[0]).toMatchObject({ ref, link: ref });
    expect(
      listMessageReferences(session, { branch: "all", entryId: firstId, limit: 1 }).messages,
    ).toHaveLength(1);
    expect(
      listMessageReferences(session, { branch: "all", entryId: "missing", limit: 1 }).messages,
    ).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("Private user content");
    expect(JSON.stringify(result)).not.toContain("Exact assistant content");
    expect(listMessageReferences(session, { roles: ["assistant"], limit: 1 })).toMatchObject({
      total: 1,
      nextOffset: null,
      messages: [{ role: "assistant" }],
    });
    expect(listMessageReferences(session, { offset: 3 })).toMatchObject({
      total: 3,
      nextOffset: null,
      messages: [],
    });
  });

  it("reads one exact Pi entry with explicit character bounds and continuation", () => {
    const { session, lastId } = fixture();
    const page = readMessageReference(session, { entryId: lastId, maxChars: 6 });
    expect(Schema.decodeUnknownSync(MessageReadResult)(page)).toEqual(page);
    expect(page).toMatchObject({
      text: "Exact ",
      totalChars: 23,
      offset: 0,
      nextOffset: 6,
      truncated: true,
    });
    expect(
      readMessageReference(session, { entryId: lastId, offset: 6, maxChars: 20 }),
    ).toMatchObject({ text: "assistant content", nextOffset: null, truncated: true });
    expect(readMessageReference(session, { entryId: lastId, offset: 100 })).toMatchObject({
      text: "",
      nextOffset: null,
    });
    expect(() => readMessageReference(session, { entryId: `${lastId}-text-0` })).toThrow(
      /does not exist/,
    );
    const custom = session.appendCustomEntry("extension.hidden", { secret: "hidden content" });
    expect(() => readMessageReference(session, { entryId: custom })).toThrow(/does not exist/);
  });

  it("preserves original references across normal compaction, Tool Compact, and branch changes", () => {
    const { session, firstId, lastId } = fixture();
    const ref = messageReference(session.getSessionId(), firstId);
    session.appendCompaction("Summary, not the original", lastId, 10_000);
    expect(readMessageReference(session, { entryId: firstId }).text).toContain(
      "Private user content",
    );
    appendToolCompactedBranch(session, lastId);
    const original = listMessageReferences(session, { branch: "all" }).messages.find(
      (message) => message.entryId === firstId,
    );
    expect(original).toMatchObject({ ref, active: false });
    expect(readMessageReference(session, { entryId: firstId })).toMatchObject({
      message: { ref, active: false },
    });
    session.branch(firstId);
    expect(readMessageReference(session, { entryId: lastId }).text).toBe("Exact assistant content");
    expect(readMessageReference(session, { entryId: lastId }).message.active).toBe(false);
  });

  it("keeps pinned Project attachment references discoverable but removes attachment envelopes from explicit message reads", () => {
    const session = SessionManager.inMemory("/project");
    const attachment = {
      kind: "file",
      name: "source.txt",
      path: "/vault/private-input-path",
      inputReference: input,
    };
    const entryId = session.appendMessage({
      role: "user",
      content: `Read this file\n<cake-file-attachment>${JSON.stringify(attachment)}</cake-file-attachment>`,
      timestamp: 1,
    });
    expect(listMessageReferences(session, {}).messages[0]?.inputRefs).toEqual([input]);
    expect(readMessageReference(session, { entryId }).text).toBe("Read this file");
    expect(JSON.stringify(readMessageReference(session, { entryId }))).not.toContain(
      "private-input-path",
    );
  });

  it("never returns image bytes from a list or textual read", () => {
    const session = SessionManager.inMemory("/project");
    const entryId = session.appendMessage({
      role: "user",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", data: "c2VjcmV0", mimeType: "image/png" },
      ],
      timestamp: 1,
    });
    expect(listMessageReferences(session, {}).messages[0]?.hasImages).toBe(true);
    const read = readMessageReference(session, { entryId });
    expect(read.text).toBe("Look at this");
    expect(JSON.stringify(read)).not.toContain("c2VjcmV0");
  });

  it("uses one reversible link/reference shape without changing Pi entry IDs", () => {
    const ref = messageReference("session uuid", "entry:42");
    expect(Schema.decodeUnknownSync(MessageReference)(ref)).toBe(ref);
    expect(messageNavigationTarget(ref)).toEqual({
      sessionId: "session uuid",
      messageId: "entry:42",
    });
    expect(parseSessionLink("cake://session/session-1")).toEqual({ sessionId: "session-1" });
    expect(parseSessionLink(`cake://session/session-1?attachment=${input.id}`)).toEqual({
      sessionId: "session-1",
      attachmentId: input.id,
    });
    expect(
      parseSessionLink(`cake://session/session-1?message=a&attachment=${input.id}`),
    ).toBeUndefined();
    expect(parseSessionLink("cake://session/session-1?attachment=not-an-input-id")).toBeUndefined();
    for (const invalid of [
      "cake://session/session-1",
      "cake://session/session-1?message=",
      "cake://session/session-1?message=a&message=b",
      "cake://session/session-1?message=a#fragment",
      "https://session/session-1?message=a",
      "cake://session/%GG?message=a",
    ])
      expect(() => Schema.decodeUnknownSync(MessageReference)(invalid)).toThrow();
  });

  it("rejects unbounded list/read inputs", () => {
    expect(() =>
      Schema.decodeUnknownSync(MessageListInput)({ sessionId: "session", limit: 101 }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MessageReadInput)({
        ref: messageReference("session", "entry"),
        maxChars: 20_001,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MessageReadInput)({
        ref: messageReference("session", "entry"),
        offset: -1,
      }),
    ).toThrow();
  });
});
