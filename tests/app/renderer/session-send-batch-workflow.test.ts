import { describe, expect, it, vi } from "vitest";
import { CakeOperationRegistry } from "../../../src/services/pi/runtime/cake-operation-registry";
import { createGlobalControlOperations } from "../../../src/services/pi/runtime/cake-session-runtime-capabilities";
import type { Client } from "../../../src/renderer/client/Client";
import { TurnId } from "../../../src/ipc/conversation-data";
import { applyConversationUpdate } from "../../../src/renderer/reducers/ConversationReducer";
import { createRendererStoreFixture } from "./renderer-store-fixture";
import { projectRecord, sessionSummary } from "./fixtures/catalog-fixtures";

const context = { signal: new AbortController().signal, toolCallId: "batch", runtime: {} };
const source = { sessionId: "sender", title: "Sender", kind: "cake-chat" as const };
const projects = [projectRecord({ path: "/a" }), projectRecord({ path: "/b" })];
const sessions = [
  sessionSummary({ sessionId: "a", projectPath: "/a" }),
  sessionSummary({ sessionId: "b", projectPath: "/b" }),
];

function operations(
  fixture: ReturnType<typeof createRendererStoreFixture>,
  activeIds: readonly string[] = [],
) {
  for (const summary of sessions) {
    fixture.root.sessionRegistry.load(summary.sessionId, summary.workingDirectory);
    applyConversationUpdate(
      fixture.models.projectConversation(summary.sessionId, summary.workingDirectory),
      {
        _tag: "Snapshot",
        revision: 1,
        snapshot: {
          sessionId: summary.sessionId,
          sessionFile: `/sessions/${summary.sessionId}.jsonl`,
          parts: [],
          models: [],
          thinkingLevel: "off",
          availableThinkingLevels: ["off"],
          streaming: activeIds.includes(summary.sessionId),
          diagnostics: [],
          commands: [],
          compatibility: { resources: [], diagnostics: [] },
          extensionUi: { statuses: [] },
          tree: [],
        },
      },
    );
  }
  const store = fixture.root.applicationControlStore;
  return new CakeOperationRegistry(
    createGlobalControlOperations(
      {
        tools: store.tools(),
        invoke: (invocation) => store.invoke(invocation, source),
      },
      () => ({ provider: "test", modelId: "test", thinkingLevel: "off", fastMode: false }),
    ),
  );
}

describe("batch tool through real session send controls", () => {
  it("registers a separate global tool and sends across projects with independent correlation", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make(crypto.randomUUID()),
    );
    using fixture = createRendererStoreFixture({
      projects,
      sessions,
      client: { sessionChats: { prompt } },
    });
    const registry = operations(fixture);
    const result = await registry.invoke(
      {
        command: "sessions.send-batch",
        input: { sessionIds: ["a", "b"], text: "Shared instructions", maxMessages: 5 },
      },
      context,
    );
    expect(result.structuredContent).toMatchObject({
      result: {
        status: "complete",
        outcomes: [
          { sessionId: "a", status: "accepted" },
          { sessionId: "b", status: "accepted" },
        ],
      },
    });
    expect(prompt).toHaveBeenCalledTimes(2);
    const inputs = prompt.mock.calls.map(([input]) => input);
    expect(inputs.map((input) => input.sessionId)).toEqual(["a", "b"]);
    for (const input of inputs)
      expect(input).toMatchObject({
        text: "Shared instructions",
        crossSession: { expectsResponse: true, maxMessages: 5, sender: { sessionId: "sender" } },
      });
    expect(inputs[0]?.crossSession?.threadId).not.toBe(inputs[1]?.crossSession?.threadId);
    expect(inputs[0]?.crossSession?.messageId).not.toBe(inputs[1]?.crossSession?.messageId);
    expect(result.text).not.toContain("Shared instructions");
    // The existing single-recipient operation remains independently registered.
    await registry.invoke(
      {
        command: "sessions.send",
        input: { sessionId: "a", text: "Single follow-up", expectsResponse: false },
      },
      context,
    );
    expect(prompt).toHaveBeenCalledTimes(3);
  });

  it("selects prompt for idle recipients and follow-up for active recipients when delivery is omitted", async () => {
    const prompt = vi.fn<Client["sessionChats"]["prompt"]>(async () =>
      TurnId.make(crypto.randomUUID()),
    );
    const followUp = vi.fn<Client["sessionChats"]["followUp"]>(async () =>
      TurnId.make(crypto.randomUUID()),
    );
    using fixture = createRendererStoreFixture({
      projects,
      sessions,
      client: {
        sessionChats: {
          prompt,
          followUp,
          listQueuedMessages: async () => ({ steering: [], followUp: [] }),
        },
      },
    });
    const result = await operations(fixture, ["b"]).invoke(
      {
        command: "sessions.send-batch",
        input: { sessionIds: ["a", "b"], text: "Ordinary message" },
      },
      context,
    );
    expect(result.structuredContent).toMatchObject({
      result: {
        status: "complete",
        outcomes: [
          { sessionId: "a", delivery: "prompt", status: "accepted" },
          { sessionId: "b", delivery: "queue", status: "queued" },
        ],
      },
    });
    expect(prompt.mock.calls.map(([input]) => input.sessionId)).toEqual(["a"]);
    expect(followUp.mock.calls.map(([input]) => input.sessionId)).toEqual(["b"]);
  });

  it("keeps unknown-target and real boundary failures alongside subsequent successes", async () => {
    const steer = vi.fn<Client["sessionChats"]["steer"]>(async (input) => {
      if (input.sessionId === "a") throw new Error("Recipient unavailable");
      return TurnId.make(crypto.randomUUID());
    });
    using fixture = createRendererStoreFixture({
      projects,
      sessions,
      client: { sessionChats: { steer } },
    });
    const result = await operations(fixture).invoke(
      {
        command: "sessions.send-batch",
        input: {
          sessionIds: ["missing", "a", "b"],
          text: "New direction",
          delivery: "steer",
          expectsResponse: false,
        },
      },
      context,
    );
    expect(result.structuredContent).toMatchObject({
      result: {
        status: "partial",
        outcomes: [
          { sessionId: "missing", ok: false, error: "Cake could not find that session." },
          { sessionId: "a", ok: false, error: "Recipient unavailable" },
          { sessionId: "b", ok: true, delivery: "steer" },
        ],
      },
    });
    expect(steer.mock.calls.map(([input]) => input.sessionId)).toEqual(["a", "b"]);
    expect(steer.mock.calls[1]?.[0].crossSession?.expectsResponse).toBe(false);
  });
});
