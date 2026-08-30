import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/ipc/session-contract";
import type { DesktopClient } from "../../../../src/renderer/desktop-client";
import { SubagentActivityStore } from "../../../../src/renderer/stores/SubagentActivityStore";

function client() {
  const steerSubagent = vi.fn(async () => undefined);
  const abortSubagent = vi.fn(async () => undefined);
  // SAFETY: This focused Store test exercises only the two subagent intents supplied here.
  return {
    value: { steerSubagent, abortSubagent } as unknown as DesktopClient,
    steerSubagent,
    abortSubagent,
  };
}

describe("SubagentActivityStore", () => {
  it("backs an active subagent with the shared interactive ChatStore", async () => {
    const api = client();
    const store = mount(
      createStore(SubagentActivityStore, {
        sessionId: "parent",
        client: api.value,
        parts: () => [],
      }),
    );
    const handleId = crypto.randomUUID();
    store.receive({
      type: "subagent-activity-received",
      activity: {
        parentSessionId: "parent",
        anchorPartId: "tool-spawn",
        handleId,
        revision: 1,
        task: "Inspect the boundary",
        profile: "reviewer",
        status: "running",
        resolvedModel: {
          requested: "current",
          source: "current",
          provider: "test",
          modelId: "model",
          thinkingLevel: "medium",
          fallbacks: [],
        },
        fastMode: false,
        retained: false,
        streaming: true,
        parts: [
          {
            id: "child-text",
            kind: "text",
            role: "assistant",
            text: "Inspecting now",
            status: "streaming",
          },
        ],
      },
    });

    const chat = store.chatStore(handleId)!;
    expect(chat.parts).toEqual([expect.objectContaining({ text: "Inspecting now" })]);
    expect(chat.composerVisible).toBe(true);
    await expect(chat.submit("Check cancellation too")).resolves.toBe(true);
    expect(api.steerSubagent).toHaveBeenCalledWith({
      parentSessionId: "parent",
      handleId,
      text: "Check cancellation too",
    });
    await chat.abort();
    expect(api.abortSubagent).toHaveBeenCalledWith({ parentSessionId: "parent", handleId });

    store.receive({ type: "subagent-activity-removed", parentSessionId: "parent", handleId });
    expect(chat.composerVisible).toBe(false);
    expect(chat.parts).toEqual([expect.objectContaining({ text: "Inspecting now" })]);
    store[Symbol.dispose]();
  });

  it("reconstructs a released read-only chat from the parent transcript", () => {
    const api = client();
    const handleId = crypto.randomUUID();
    const parts: UiPart[] = [
      {
        id: "tool-spawn",
        kind: "tool",
        name: "cake",
        command: "subagents.start",
        input: JSON.stringify({ task: "Tell a joke", profile: "worker" }),
        output: JSON.stringify({ handleId, status: "running" }),
        state: "success",
      },
      {
        id: "tool-wait",
        kind: "tool",
        name: "cake",
        command: "subagents.wait",
        input: JSON.stringify({ handleId }),
        output: JSON.stringify({
          handleId,
          task: "Tell a joke",
          profile: "worker",
          status: "complete",
          parts: [
            {
              id: "child-answer",
              kind: "text",
              role: "assistant",
              text: "A historical punchline.",
              status: "complete",
            },
          ],
        }),
        state: "success",
      },
    ];
    const store = mount(
      createStore(SubagentActivityStore, {
        sessionId: "parent",
        client: api.value,
        parts: () => parts,
      }),
    );

    const chat = store.chatStore(handleId)!;
    expect(chat.parts).toEqual([expect.objectContaining({ text: "A historical punchline." })]);
    expect(chat.composerVisible).toBe(false);
    expect(chat.canStop).toBe(false);
    store[Symbol.dispose]();
  });
});
