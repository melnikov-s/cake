import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ResolvedAgentModel,
  SubagentActivity,
  SubagentHandleId,
  SubagentUpdate,
} from "../../../src/domain/subagents/subagent-data";
import { CakeIpcClient } from "../../../src/ipc/client/CakeIpcClient";
import { makeRuntime } from "../../../src/renderer/runtime";

const handleId = "00000000-0000-4000-8000-000000000001";
const resolvedModel = {
  requested: "current" as const,
  source: "current" as const,
  provider: "openai-codex",
  modelId: "gpt-5.6-sol",
  thinkingLevel: "high" as const,
  fallbacks: [],
};
const activity = {
  parentSessionId: "parent",
  anchorPartId: "tool-call",
  handleId,
  revision: 1,
  task: "Audit the boundary",
  profile: "reviewer" as const,
  status: "running" as const,
  resolvedModel,
  fastMode: false,
  retained: false,
  streaming: true,
  parts: [],
};

describe("Subagent Effect RPC contract", () => {
  it("decodes stable handles and current-first activity updates", () => {
    expect(Schema.decodeUnknownSync(SubagentHandleId)(handleId)).toBe(handleId);
    expect(Schema.decodeUnknownSync(ResolvedAgentModel)(resolvedModel)).toEqual(resolvedModel);
    expect(Schema.decodeUnknownSync(SubagentActivity)(activity)).toEqual(activity);
    expect(
      Schema.decodeUnknownSync(SubagentUpdate)({
        _tag: "Snapshot",
        revision: 3,
        parentSessionId: "parent",
        activities: [activity],
        backgroundActive: true,
      }),
    ).toMatchObject({ _tag: "Snapshot", backgroundActive: true });
  });

  it("rejects malformed handles and statuses", () => {
    expect(() => Schema.decodeUnknownSync(SubagentHandleId)("private-session-id")).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SubagentActivity)({ ...activity, status: "released" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(SubagentUpdate)({
        _tag: "Removed",
        revision: 4,
        parentSessionId: "parent",
        handleId: "private-session-id",
      }),
    ).toThrow();
  });

  it("exposes the generated subagent client group", async () => {
    const runtime = makeRuntime({
      send() {},
      subscribe() {
        return () => {};
      },
    });
    const client = await runtime.execute(Effect.service(CakeIpcClient));
    expect(Object.keys(client.subagents ?? {})).toEqual(["observe", "steer", "abort", "close"]);
    await runtime.dispose();
  });
});
