import { applySnapshot, child, createStore, mount, Store } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { UiPart } from "../../../../src/ipc/session-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { ClientContext } from "../../../../src/renderer/stores/context/ClientContext";
import { Session } from "../../../../src/renderer/models/Session";
import { SubagentActivityStore } from "../../../../src/renderer/stores/SubagentActivityStore";

class HarnessStore extends Store<{
  client: Client;
  model: Session;
  parts(): readonly UiPart[];
}> {
  [ClientContext.provide]() {
    return this.props.client;
  }

  @child get activity() {
    return createStore(SubagentActivityStore, {
      sessionId: "parent",
      model: this.props.model,
      parts: this.props.parts,
    });
  }
}

function harness(model: Session, parts: () => readonly UiPart[] = () => []) {
  const prompt = vi.fn(async () => undefined);
  const steer = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const client = {
    subagents: { prompt, steer, abort },
  } as unknown as Client;
  const root = mount(createStore(HarnessStore, { client, model, parts }));
  return { root, store: root.activity, prompt, steer, abort };
}

const activity = (handleId: string) => ({
  parentSessionId: "parent",
  anchorPartId: "tool-spawn",
  handleId,
  revision: 1,
  task: "Inspect the boundary",
  status: "running" as const,
  resolvedModel: {
    requested: "current" as const,
    source: "current" as const,
    provider: "test",
    modelId: "model",
    thinkingLevel: "medium" as const,
    fallbacks: [],
  },
  fastMode: false,
  streaming: true,
  parts: [
    {
      id: "child-text",
      kind: "text" as const,
      role: "assistant" as const,
      text: "Inspecting now",
      status: "streaming" as const,
    },
  ],
});

describe("SubagentActivityStore", () => {
  it("reads synchronized activity Models and backs them with shared ChatStore", async () => {
    const handleId = crypto.randomUUID();
    const model = Session.create({
      sessionId: "parent",
      subagentActivities: [activity(handleId)],
    });
    const fixture = harness(model);

    const chat = fixture.store.chatStore(handleId)!;
    expect(chat.parts).toEqual([expect.objectContaining({ text: "Inspecting now" })]);
    expect(chat.composerVisible).toBe(true);
    await expect(chat.submit("Check cancellation too")).resolves.toBe(true);
    expect(fixture.steer).toHaveBeenCalledWith(
      { parentSessionId: "parent", handleId, text: "Check cancellation too" },
      { signal: fixture.store.signal },
    );
    await chat.abort();
    expect(fixture.abort).toHaveBeenCalledWith(
      { parentSessionId: "parent", handleId },
      { signal: fixture.store.signal },
    );

    applySnapshot(model.subagentActivities[0]!, {
      status: "complete",
      streaming: false,
    });
    expect(chat.composerVisible).toBe(true);
    await expect(chat.submit("One follow-up")).resolves.toBe(true);
    expect(fixture.prompt).toHaveBeenCalledWith(
      { parentSessionId: "parent", handleId, text: "One follow-up" },
      { signal: fixture.store.signal },
    );

    applySnapshot(model, { releasedSubagentHandleIds: [handleId] });
    expect(chat.composerVisible).toBe(false);
    expect(chat.parts).toEqual([expect.objectContaining({ text: "Inspecting now" })]);
    fixture.root[Symbol.dispose]();
    model[Symbol.dispose]();
  });

  it("reconstructs a released read-only chat from the parent transcript", () => {
    const handleId = crypto.randomUUID();
    const parts: UiPart[] = [
      {
        id: "tool-spawn",
        kind: "tool",
        name: "cake",
        command: "subagents.start",
        input: JSON.stringify({ task: "Tell a joke" }),
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
    const model = Session.create({ sessionId: "parent" });
    const fixture = harness(model, () => parts);

    const chat = fixture.store.chatStore(handleId)!;
    expect(chat.parts).toEqual([expect.objectContaining({ text: "A historical punchline." })]);
    expect(chat.composerVisible).toBe(false);
    expect(chat.canStop).toBe(false);
    fixture.root[Symbol.dispose]();
    model[Symbol.dispose]();
  });
});
