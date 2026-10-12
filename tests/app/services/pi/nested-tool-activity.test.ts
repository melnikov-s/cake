import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  uiPartSchema,
  type UiPart,
} from "../../../../src/contracts/conversations/session-contract";
import { createCakeSessionRuntimeEventProjection } from "../../../../src/services/pi/runtime/cake-session-runtime-event-projection";
import {
  projectNestedToolCalls,
  projectSessionEntries,
} from "../../../../src/services/pi/runtime/session-projection";
import { Conversation } from "../../../../src/renderer/models/Conversation";
import {
  applyPartUpdate,
  messageSnapshots,
} from "../../../../src/renderer/reducers/SessionPartReducer";
import {
  nestedAssistant,
  nestedArgumentBytes,
  nestedLargeArguments,
  nestedEntries,
  nestedResult,
  nestedScript,
  nestedSummary,
  nestedUsage,
} from "../../../fixtures/nested-tool-activity";

type ToolPart = Extract<UiPart, { kind: "tool" }>;
function harness() {
  const conversation = Conversation.create({ sessionId: "test" });
  const parts: ToolPart[] = [];
  const stats = {
    tokens: { input: 24, output: 6, cacheRead: 0, cacheWrite: 0, total: 30 },
    cost: 0.6,
  };
  // SAFETY: only queue accessors and Pi's authoritative statistics are invoked by this projector.
  const session = {
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getSessionStats: () => stats,
  } as unknown as AgentSession;
  const projection = createCakeSessionRuntimeEventProjection({
    session,
    sessionId: "test",
    compactionQueuedMessages: () => [],
    isDisposed: () => false,
    emit: (event) => {
      if (event.type !== "part-updated") return;
      const part = Schema.decodeUnknownSync(uiPartSchema)(event.part);
      applyPartUpdate(conversation.parts, part, "test");
      if (part.kind === "tool") parts.push(part);
    },
  });
  const send = (event: AgentSessionEvent) => projection.projectEvent(event);
  const tool = (id = "tool-script") =>
    conversation.uiParts.find((part): part is ToolPart => part.kind === "tool" && part.id === id)!;
  return {
    projection,
    conversation,
    parts,
    send,
    tool,
    stats,
    dispose: () => {
      projection.dispose();
      conversation[Symbol.dispose]();
    },
  };
}
const start = (
  toolCallId: string,
  parentToolCallId?: string,
  toolName = "read",
): AgentSessionEvent => ({
  type: "tool_execution_start",
  toolCallId,
  toolName,
  args:
    toolName === "codemode"
      ? { code: nestedScript }
      : toolName === "write"
        ? nestedLargeArguments
        : (nestedSummary.calls.find((call) => call.id === toolCallId)?.arguments ?? {
            path: `${toolCallId}.ts`,
          }),
  parentToolCallId,
});
const end = (
  toolCallId: string,
  parentToolCallId?: string,
  isError = false,
  text = "result",
  toolName = "read",
): AgentSessionEvent => ({
  type: "tool_execution_end",
  toolCallId,
  toolName,
  parentToolCallId,
  isError,
  result: { content: [{ type: "text", text }], details: {}, usage: nestedUsage },
});

describe("nested tool activity boundary", () => {
  it("groups parallel, interleaved children and descendants by explicit root in start order", () => {
    const h = harness();
    try {
      h.send({ type: "message_start", message: nestedAssistant });
      h.send({ type: "message_end", message: nestedAssistant });
      h.send(start("script", undefined, "codemode"));
      h.send(start("other", undefined, "codemode"));
      h.send(start("script/1", "script"));
      h.send(start("other/1", "other"));
      h.send(start("script/2", "script"));
      // IDs are deliberately unrelated: the public relationship, not string splitting, is authority.
      h.send(start("arbitrary-grandchild", "script/1"));
      h.send({
        type: "tool_execution_update",
        toolCallId: "script/2",
        toolName: "read",
        parentToolCallId: "script",
        args: { path: "b.ts" },
        partialResult: { content: [{ type: "text", text: "partial" }], details: {} },
      });
      expect(h.tool().nestedCalls?.calls[1]).toMatchObject({ state: "running", output: "partial" });
      h.send(end("script/2", "script", true, "Read cancelled"));
      h.send(end("other/1", "other", false, "other result"));
      h.send(end("arbitrary-grandchild", "script/1", false, "deep result"));
      h.send(end("script/1", "script", false, "first result"));
      h.send(
        end(
          "script",
          undefined,
          true,
          nestedResult.content[0]!.type === "text" ? nestedResult.content[0]!.text : "",
          "codemode",
        ),
      );
      expect(h.tool()).toMatchObject({ input: nestedScript, state: "error" });
      expect(h.tool().nestedCalls?.calls.map((call) => [call.id, call.state, call.output])).toEqual(
        [
          ["tool-script/1", "success", "first result"],
          ["tool-script/2", "error", "Read cancelled"],
          ["tool-arbitrary-grandchild", "success", "deep result"],
        ],
      );
      expect(h.tool("tool-other").nestedCalls?.calls).toHaveLength(1);
      expect(h.conversation.uiParts.map((part) => part.id)).toEqual(["tool-script", "tool-other"]);
      expect(new Set(h.parts.map((part) => part.id))).toEqual(
        new Set(["tool-script", "tool-other"]),
      );
    } finally {
      h.dispose();
    }
  });

  it("keeps observed results until saved-history replacement, retaining metadata and identities", () => {
    const h = harness();
    try {
      h.send(start("script", undefined, "codemode"));
      h.send(start("script/1", "script"));
      h.send(start("script/2", "script"));
      h.send(start("script/3", "script", "write"));
      h.send(end("script/1", "script", false, "export const result = 1;"));
      h.send(end("script/2", "script", true, "Read cancelled"));
      h.send(end("script", undefined, true, "Script failed", "codemode"));
      h.send({ type: "message_end", message: nestedResult });
      expect(h.tool().nestedCalls).toMatchObject({
        complete: false,
        calls: [
          {
            id: "tool-script/1",
            state: "success",
            output: "export const result = 1;",
            outputAvailability: "live",
            durationMs: 15,
          },
          {
            id: "tool-script/2",
            state: "error",
            output: "Read cancelled",
            errorSummary: "Read cancelled",
          },
          { id: "tool-script/3", state: "interrupted" },
        ],
      });
      const reopened = projectSessionEntries(nestedEntries());
      const parent = Schema.decodeUnknownSync(uiPartSchema)(reopened[0]);
      applyPartUpdate(h.conversation.parts, parent, "test");
      expect(h.tool()).toMatchObject({
        input: nestedScript,
        state: "error",
        nestedCalls: {
          complete: false,
          calls: [
            {
              id: "tool-script/1",
              state: "success",
              outputAvailability: "unavailable",
              durationMs: 15,
            },
            {
              id: "tool-script/2",
              state: "error",
              errorSummary: "Read cancelled",
              outputAvailability: "unavailable",
            },
            {
              id: "tool-script/3",
              inputUnavailable: true,
              argumentsBytes: nestedArgumentBytes,
              state: "interrupted",
            },
          ],
        },
      });
      expect(h.tool().nestedCalls?.calls.every((call) => call.output === undefined)).toBe(true);
      const restored = Conversation.create({
        sessionId: "restored",
        parts: messageSnapshots(reopened, "restored"),
      });
      expect(restored.uiParts).toEqual(h.conversation.uiParts);
      restored[Symbol.dispose]();
    } finally {
      h.dispose();
    }
  });

  it("settles unrecorded child work as interrupted without treating Pi cancellation errors as success", () => {
    const h = harness();
    try {
      h.send(start("script", undefined, "codemode"));
      h.send(start("waiting", "script"));
      h.send(start("cancelled", "script"));
      h.send(end("cancelled", "script", true, "Tool execution aborted"));
      h.send({ type: "agent_settled" });
      expect(h.tool().nestedCalls).toMatchObject({
        complete: false,
        calls: [{ state: "interrupted" }, { state: "error", output: "Tool execution aborted" }],
      });
    } finally {
      h.dispose();
    }
  });

  it("leaves top-level tool results unchanged and never adds child usage to Pi session totals", () => {
    const h = harness();
    try {
      const before = h.projection.currentUsage();
      // Model-issued IDs can also contain slashes; only parentToolCallId makes a child.
      h.send(start("direct/1"));
      h.send(end("direct/1", undefined, false, "direct output"));
      expect(h.tool("tool-direct/1")).toMatchObject({
        state: "success",
        input: '{\n  "path": "direct/1.ts"\n}',
        output: "direct output",
      });
      expect(h.tool("tool-direct/1").nestedCalls).toBeUndefined();
      h.send(start("script", undefined, "codemode"));
      h.send(start("script/1", "script"));
      h.send(end("script/1", "script"));
      h.send({ type: "message_end", message: nestedResult });
      expect(h.projection.currentUsage()).toEqual(before);
      expect(before).toEqual(h.stats);
      expect(h.tool().nestedCalls?.calls[0]).not.toHaveProperty("usage");
    } finally {
      h.dispose();
    }
  });

  it("bounds live activity, marks dropped calls incomplete, and validates persisted metadata", () => {
    const h = harness();
    try {
      h.send(start("script", undefined, "codemode"));
      for (let index = 0; index < 256; index++) h.send(start(`c${index}`, "script"));
      expect(h.tool().nestedCalls?.complete).toBeUndefined();
      h.send(start("dropped", "script"));
      expect(h.tool().nestedCalls).toMatchObject({ complete: false });
      expect(h.tool().nestedCalls?.calls).toHaveLength(256);
      expect(
        projectNestedToolCalls({
          ...nestedSummary,
          calls: [{ ...nestedSummary.calls[0], status: "made-up" }],
        }),
      ).toBeUndefined();
      expect(
        projectNestedToolCalls({
          ...nestedSummary,
          calls: [{ ...nestedSummary.calls[0], error: "x".repeat(900) }],
        })?.calls[0]?.errorSummary,
      ).toHaveLength(500);
    } finally {
      h.dispose();
    }
  });
});
