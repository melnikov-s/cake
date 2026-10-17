import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  recoveryInputEntryType,
  restartDecision,
} from "../../../src/services/pi/runtime/restart-recovery";

type Message = Extract<SessionEntry, { type: "message" }>["message"];
let id = 0;
const message = (value: Message): SessionEntry => ({
  type: "message",
  id: String(++id),
  parentId: null,
  timestamp: new Date(0).toISOString(),
  message: value,
});
const marker = (turnId = "turn"): SessionEntry => ({
  type: "custom",
  customType: recoveryInputEntryType,
  data: { turnId, timestamp: 0 },
  id: String(++id),
  parentId: null,
  timestamp: new Date(0).toISOString(),
});
const user = () => message({ role: "user", content: "work", timestamp: 0 });
const assistant = (overrides: Partial<AssistantMessage> = {}) =>
  message({
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    api: "openai-completions",
    provider: "fixture",
    model: "fixture",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...overrides,
  });
const call = () =>
  assistant({
    content: [{ type: "toolCall", id: "mutation", name: "bash", arguments: { command: "mutate" } }],
    stopReason: "toolUse",
  });
const result = () =>
  message({
    role: "toolResult",
    toolCallId: "mutation",
    toolName: "bash",
    content: [{ type: "text", text: "success" }],
    isError: false,
    timestamp: 0,
  });

describe("restart transcript reconciliation", () => {
  it("only resubmits input which Pi has not consumed", () => {
    expect(restartDecision([], "turn").kind).toBe("pending");
    expect(restartDecision([marker()], "turn").kind).toBe("pending");
    expect(restartDecision([marker(), user()], "turn").kind).toBe("resume");
  });
  it("resumes both crash-at-user and clean-quit aborted streams without replaying the user message", () => {
    expect(restartDecision([marker(), user()], "turn").kind).toBe("resume");
    expect(
      restartDecision([marker(), user(), assistant({ stopReason: "aborted" })], "turn").kind,
    ).toBe("resume");
  });
  it("reconciles an already completed reply idempotently instead of generating it again", () => {
    const branch = [marker(), user(), assistant()];
    expect(restartDecision(branch, "turn")).toEqual({
      kind: "settled",
      result: { stopReason: "stop", text: "Done" },
    });
    expect(restartDecision(branch, "turn")).toEqual(restartDecision(branch, "turn"));
  });
  it("preserves failed outcomes instead of automatically restarting failed work", () => {
    expect(
      restartDecision(
        [marker(), user(), assistant({ stopReason: "error", errorMessage: "provider failed" })],
        "turn",
      ),
    ).toEqual({
      kind: "settled",
      result: { stopReason: "error", text: "Done", errorMessage: "provider failed" },
    });
  });
  it("never replays a tool whose side effect might have completed without a saved result", () => {
    const ambiguous = [marker(), user(), call()];
    expect(restartDecision(ambiguous, "turn").kind).toBe("blocked");
    // A later response cannot make an unresolved mutation safe to repeat.
    expect(restartDecision([...ambiguous, assistant()], "turn").kind).toBe("blocked");
    expect(restartDecision([...ambiguous, result()], "turn").kind).toBe("resume");
    expect(restartDecision([...ambiguous, result(), assistant()], "turn").kind).toBe("settled");
  });
  it("keeps later answers, failures and unfinished tools out of an earlier input", () => {
    const first = [marker(), user(), assistant()];
    for (const later of [
      assistant({ content: [{ type: "text", text: "Later answer" }] }),
      assistant({ stopReason: "error", errorMessage: "Later failure" }),
      call(),
    ]) {
      expect(restartDecision([...first, marker("later"), user(), later], "turn")).toEqual({
        kind: "settled",
        result: { stopReason: "stop", text: "Done" },
      });
    }
  });
  it("shares the final answer across steering inputs in the same unfinished run", () => {
    const branch = [marker(), user(), call(), result(), marker("steer"), user(), assistant()];
    for (const turnId of ["turn", "steer"])
      expect(restartDecision(branch, turnId)).toEqual({
        kind: "settled",
        result: { stopReason: "stop", text: "Done" },
      });
  });
  it("uses a successful retry in the same run rather than the preceding provider error", () => {
    expect(
      restartDecision([marker(), user(), assistant({ stopReason: "error" }), assistant()], "turn"),
    ).toEqual({
      kind: "settled",
      result: { stopReason: "stop", text: "Done" },
    });
  });
  it("does not include an answer triggered by a subsequent custom worker report", () => {
    const report: SessionEntry = {
      type: "custom_message",
      customType: "cake.subagent-completion",
      content: "Worker done",
      display: false,
      id: String(++id),
      parentId: null,
      timestamp: new Date(0).toISOString(),
    };
    expect(restartDecision([marker(), user(), assistant(), report, call()], "turn")).toEqual({
      kind: "settled",
      result: { stopReason: "stop", text: "Done" },
    });
  });
  it("does not use historical work before this accepted input's marker", () => {
    expect(restartDecision([call(), marker(), user()], "turn").kind).toBe("resume");
    expect(restartDecision([marker("another"), user(), assistant()], "turn").kind).toBe("pending");
  });
});
