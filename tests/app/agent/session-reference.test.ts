import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  projectSessionReferences,
  resolveSessionReference,
  sessionReference,
} from "../../../src/contracts/project-sessions/session-reference";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
  projectCrossSessionMessageForAgent,
} from "../../../src/contracts/conversations/cross-session-message";
import {
  labelIn,
  projectIn,
  resolveIn,
} from "../../../src/domain/project-sessions/sessionReferences";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createSessionSendBatchOperation } from "../../../src/domain/conversations/cake-session-batch-send-operation";
import { SessionSendBatchResult } from "../../../src/contracts/conversations/session-send-batch";

const a = "01957936-0000-7000-8000-000112345678";
const b = "01957936-0000-7000-8000-000212345678";
const c = "01957936-0000-7000-8000-000187654321";
const ids = [a, b, c];
const roster = ids.map((sessionId, index) => ({ sessionId, title: `Worker ${index}` }));
const context = { signal: new AbortController().signal, toolCallId: "call", runtime: {} };

describe("session references", () => {
  it("emits eight trailing hex characters, not shared UUIDv7 prefixes", () => {
    expect(sessionReference(a, [a, c])).toBe("s:12345678");
    expect(sessionReference(c, ids)).toBe("s:87654321");
  });

  it("extends suffixes on collision, ignoring duplicated catalog entries", () => {
    expect(sessionReference(a, [...ids, a])).toBe("s:112345678");
    expect(sessionReference(b, ids)).toBe("s:212345678");
    expect(resolveSessionReference("s:112345678", ids)).toEqual({ ok: true, sessionId: a });
    expect(resolveSessionReference("s:12345678", [a, a])).toEqual({ ok: true, sessionId: a });
  });

  it("extends across UUID hyphens up to all 32 hex characters", () => {
    const left = "01957936-0000-7000-8000-000112345678";
    const right = "11957936-0000-7000-8000-000112345678";
    const ref = sessionReference(left, [left, right]);
    expect(ref).toBe(`s:${left.replaceAll("-", "")}`);
    expect(resolveSessionReference(ref, [left, right])).toEqual({ ok: true, sessionId: left });
  });

  it("fails unknown and ambiguous references rather than selecting a recipient", () => {
    expect(resolveSessionReference("s:12345678", ids)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Ambiguous"),
    });
    expect(resolveSessionReference("s:ffffffff", ids)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Unknown"),
    });
  });

  it.each(["s:1234567", "s:1234567z", "s:12345678-", "s:" + "f".repeat(33), a.slice(0, 8)])(
    "rejects malformed reference %s",
    (ref) => {
      expect(resolveSessionReference(ref, ids).ok).toBe(false);
    },
  );

  it("passes exact canonical identities through and accepts uppercase suffix hex", () => {
    expect(resolveSessionReference(a, ids)).toEqual({ ok: true, sessionId: a });
    const uppercaseId = "01957936-0000-7000-8000-0000abcdefab";
    expect(resolveSessionReference("S:ABCDEFAB", [uppercaseId])).toEqual({
      ok: true,
      sessionId: uppercaseId,
    });
    expect(sessionReference("cake-chat", ids)).toBe("cake-chat");
    expect(resolveSessionReference("cake-chat", ["cake-chat"])).toEqual({
      ok: true,
      sessionId: "cake-chat",
    });
  });

  it("projects rosters, family identities, board audiences and receipts, not unrelated IDs or text", () => {
    const value = {
      sessionId: a,
      rootSessionId: b,
      familyChildSessionIds: [c],
      audience: [a],
      authorSessionId: b,
      familyId: a,
      messageId: a,
      threadId: a,
      title: "Worker",
      text: a,
      path: `/sessions/${a}.jsonl`,
    };
    expect(projectSessionReferences(value, ids)).toEqual({
      ...value,
      sessionId: "s:112345678",
      rootSessionId: "s:212345678",
      familyChildSessionIds: ["s:87654321"],
      audience: ["s:112345678"],
      authorSessionId: "s:212345678",
    });
    expect(value.sessionId).toBe(a);
  });

  it("offers scoped domain helpers for boards and reminders with readable labels", async () => {
    await expect(Effect.runPromise(resolveIn("s:112345678", roster))).resolves.toBe(a);
    await expect(Effect.runPromise(resolveIn("s:12345678", roster))).rejects.toThrow("Ambiguous");
    expect(projectIn({ audience: [b], sessionId: a }, roster)).toEqual({
      audience: ["s:212345678"],
      sessionId: "s:112345678",
    });
    expect(labelIn(a, roster)).toBe("s:112345678 (Worker 0)");
  });

  it("projects message envelopes and generated notice headers only in agent context", () => {
    const content = encodeCrossSessionMessage(`Session ${a} stopped without replying.`, {
      version: 1,
      messageId: "00000000-0000-4000-8000-000000000001",
      threadId: "00000000-0000-4000-8000-000000000002",
      sequence: 1,
      expectsResponse: false,
      generatedNotice: true,
      sender: { sessionId: a, title: "Authentication review", kind: "project-session" },
    });
    const projected = parseCrossSessionMessage(projectCrossSessionMessageForAgent(content, ids));
    expect(projected?.metadata.sender).toMatchObject({
      sessionId: "s:112345678",
      title: "Authentication review",
    });
    expect(projected?.text).toBe("Session s:112345678 stopped without replying.");
    expect(parseCrossSessionMessage(content)?.metadata.sender.sessionId).toBe(a);
    expect(projectCrossSessionMessageForAgent("Ordinary user text", ids)).toBe(
      "Ordinary user text",
    );
  });

  it("emits short IDs in roster text and valid typed results", async () => {
    const outputSchema = Schema.Struct({
      sessions: Schema.Array(Schema.Struct({ sessionId: Schema.String, title: Schema.String })),
    });
    const registry = new CakeOperationRegistry(
      [
        {
          command: "sessions.list",
          topic: "sessions",
          summary: "Roster",
          inputSchema: Schema.Struct({}),
          outputSchema,
          examples: [{}],
          result: "Sessions",
          execute: async () => ({ sessions: roster }),
        },
      ],
      async (value) => projectSessionReferences(value, ids),
    );
    expect(registry.topicHelp("sessions")).toContain("s:<at least 8 trailing hex characters>");
    const result = await registry.invoke({ command: "sessions.list" }, context);
    expect(result.text).toContain("s:112345678");
    expect(result.text).toContain("Worker 0");
    expect(result.structuredContent).toEqual({
      command: "sessions.list",
      result: {
        sessions: [
          { sessionId: "s:112345678", title: "Worker 0" },
          { sessionId: "s:212345678", title: "Worker 1" },
          { sessionId: "s:87654321", title: "Worker 2" },
        ],
      },
    });
  });

  it("keeps typed batch receipts valid and routes resolved targets with canonical IDs", async () => {
    const routed: string[] = [];
    const operation = createSessionSendBatchOperation(async (input) => {
      const reference = Schema.decodeUnknownSync(Schema.String)(input.sessionId);
      const canonical = await Effect.runPromise(resolveIn(reference, roster));
      routed.push(canonical);
      return {
        ok: true,
        command: "sessions.send",
        messageId: "00000000-0000-4000-8000-000000000001",
        delivery: "prompt",
        status: "accepted",
      };
    });
    const registry = new CakeOperationRegistry([operation], async (value) =>
      projectSessionReferences(value, ids),
    );
    const result = await registry.invoke(
      {
        command: "sessions.send-batch",
        input: {
          sessionIds: [a, "s:212345678", "s:ffffffff"],
          text: "Review",
          expectsResponse: false,
        },
      },
      context,
    );
    const output = Schema.decodeUnknownSync(
      Schema.Struct({ command: Schema.String, result: SessionSendBatchResult }),
    )(result.structuredContent).result;
    expect(routed).toEqual([a, b]);
    expect(output.status).toBe("partial");
    expect(output.outcomes.map((outcome) => outcome.sessionId)).toEqual([
      "s:112345678",
      "s:212345678",
      "s:ffffffff",
    ]);
  });

  it("preserves canonical typed fields when their schema requires UUIDs while shortening text", async () => {
    const id = "00000000-0000-4000-8000-000112345678";
    const outputSchema = Schema.Struct({ sessionId: Schema.String.check(Schema.isUUID(4)) });
    const registry = new CakeOperationRegistry(
      [
        {
          command: "session.info",
          topic: "sessions",
          summary: "Identity",
          inputSchema: Schema.Struct({}),
          outputSchema,
          examples: [{}],
          result: "Session",
          execute: async () => ({ sessionId: id }),
        },
      ],
      async (value) => projectSessionReferences(value, [id]),
    );
    const result = await registry.invoke({ command: "session.info" }, context);
    expect(result.text).toContain("s:12345678");
    expect(result.structuredContent).toEqual({
      command: "session.info",
      result: { sessionId: id },
    });
  });
});
