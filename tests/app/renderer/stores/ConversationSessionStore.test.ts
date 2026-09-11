import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { Message } from "../../../../src/renderer/models/Message";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { ConversationSessionStore } from "../../../../src/renderer/stores/ConversationSessionStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithClient } from "../mount-with-client";

function fixture(chatOverrides: Partial<ConversationSessionStore["props"]["chat"]> = {}) {
  const models = RootProjection.create();
  const model = models.projectSession("session-1", "/project");
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const deliver = vi.fn(async () => true);
  const editMessage = vi.fn(async () => undefined);
  const setModel = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const rewordComposerSelection = vi.fn(async () => "Reworded");
  const mounted = mountWithClient(
    createStore(ConversationSessionStore, {
      sessionId: "session-1",
      model,
      operations,
      composerOperationOwner: "composer:session-1",
      configurationOperationOwner: "configuration:session-1",
      canSubmit: () => true,
      composer: {
        queueWhileStreaming: () => true,
        renameSession: async () => undefined,
        toolCompactSession: async () => false,
        deliver,
        editMessage,
        compact: async () => undefined,
      },
      configuration: {
        setConfiguration: async () => undefined,
        setModel,
        setThinkingLevel: async () => undefined,
        setFastMode: async () => undefined,
      },
      chat: {
        commands: () => model.commands,
        placeholder: () => "Ask Cake…",
        inputLabel: () => "Message",
        userMessagePresentation: { setMarkdown: async () => undefined },
        abort,
        ...chatOverrides,
      },
      modelPresets: () => [],
      openModelPresetSettings: () => undefined,
    }),
    {
      electron: { showComposerContextMenu: async () => "reword" },
      workspaces: { rewordComposerSelection },
    } as unknown as Client,
  );
  return {
    ...mounted,
    model,
    models,
    operations,
    deliver,
    editMessage,
    setModel,
    abort,
    rewordComposerSelection,
    dispose() {
      mounted.root[Symbol.dispose]();
      operations[Symbol.dispose]();
      models[Symbol.dispose]();
    },
  };
}

describe("ConversationSessionStore", () => {
  it("owns stable Chat, Composer, and Configuration child identities", () => {
    const { subject, dispose } = fixture();
    const composer = subject.composerStore;
    const configuration = subject.configurationStore;
    const chat = subject.chatStore;

    expect(subject.composerStore).toBe(composer);
    expect(subject.configurationStore).toBe(configuration);
    expect(subject.chatStore).toBe(chat);
    expect(chat.configuration).toBe(configuration);
    expect(chat.id).toBe("session-1");

    dispose();
  });

  it("routes delivery, queue, configuration, abort, edit, and reword capabilities", async () => {
    const fixtureValue = fixture();
    const { subject, model, deliver, editMessage, setModel, abort, rewordComposerSelection } =
      fixtureValue;
    const chat = subject.chatStore;

    await chat.submit("Initial prompt");
    expect(deliver).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Initial prompt", delivery: "prompt" }),
    );
    expect(subject.composerStore.deliveryStore.optimisticUserMessages.pending).toHaveLength(1);

    await subject.configurationStore.selectModel("openai/gpt-5");
    expect(setModel).toHaveBeenCalledWith("openai", "gpt-5");

    model.streaming = true;
    await chat.submit("Queued follow-up");
    const queued = subject.composerStore.promptQueueStore.prompts[0]!;
    expect(queued.text).toBe("Queued follow-up");
    expect(deliver).toHaveBeenCalledTimes(1);
    chat.steerQueuedPrompt(queued.id);
    await vi.waitFor(() =>
      expect(deliver).toHaveBeenLastCalledWith(
        expect.objectContaining({ text: "Queued follow-up", delivery: "steer" }),
      ),
    );

    await chat.abort();
    expect(abort).toHaveBeenCalledOnce();

    model.streaming = false;
    model.parts.push(
      Message.create({
        id: "user-1",
        partKey: "user-1",
        piId: "entry-1",
        kind: "text",
        role: "user",
        text: "Original",
        status: "complete",
      }),
    );
    chat.editLastUserMessage("entry-1");
    chat.setDraft("Edited");
    await chat.submit();
    expect(editMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "Edited" }));

    await expect(chat.rewordComposerSelection("Rough wording")).resolves.toBe("Reworded");
    expect(rewordComposerSelection).toHaveBeenCalledWith(
      { selection: "Rough wording", prompt: undefined },
      expect.any(Object),
    );

    fixtureValue.dispose();
  });

  it("routes queue edits to the local queue or Pi's held queue by prompt identity", async () => {
    const removeRuntimeQueuedPrompt = vi.fn(async () => undefined);
    const steerRuntimeQueuedPrompt = vi.fn(async () => undefined);
    const fixtureValue = fixture({
      steeringPrompts: () => [
        {
          id: "queued-follow-up-abc-1",
          text: "Check the build",
          attachments: [],
          renderUserMessageAsMarkdown: false,
          state: "queued",
          editable: false,
          scheduled: {
            version: 1,
            id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
            createdAt: "2026-09-04T11:59:00.000Z",
            sendAt: "2026-09-04T12:02:00.000Z",
          },
        },
      ],
      removeRuntimeQueuedPrompt,
      steerRuntimeQueuedPrompt,
    });
    const { subject, model, deliver } = fixtureValue;
    const chat = subject.chatStore;

    model.streaming = true;
    await chat.submit("Local follow-up");
    const local = subject.composerStore.promptQueueStore.prompts[0]!;
    expect(chat.queuedPrompts.map((entry) => entry.id)).toEqual([
      local.id,
      "queued-follow-up-abc-1",
    ]);

    chat.removeQueuedPrompt("queued-follow-up-abc-1");
    expect(removeRuntimeQueuedPrompt).toHaveBeenCalledWith("queued-follow-up-abc-1");
    expect(subject.composerStore.promptQueueStore.prompts).toHaveLength(1);

    chat.steerQueuedPrompt("queued-follow-up-abc-1");
    expect(steerRuntimeQueuedPrompt).toHaveBeenCalledWith("queued-follow-up-abc-1");
    expect(deliver).not.toHaveBeenCalled();

    chat.removeQueuedPrompt(local.id);
    expect(subject.composerStore.promptQueueStore.prompts).toHaveLength(0);
    expect(removeRuntimeQueuedPrompt).toHaveBeenCalledOnce();

    fixtureValue.dispose();
  });

  it("surfaces a failed runtime queue edit as a composer error", async () => {
    const fixtureValue = fixture({
      steeringPrompts: () => [
        {
          id: "queued-follow-up-abc-1",
          text: "Check the build",
          attachments: [],
          renderUserMessageAsMarkdown: false,
          state: "queued",
          editable: false,
        },
      ],
      removeRuntimeQueuedPrompt: async () => {
        throw new Error("Session was aborted");
      },
    });
    const { subject } = fixtureValue;

    subject.chatStore.removeQueuedPrompt("queued-follow-up-abc-1");
    await vi.waitFor(() => expect(subject.error.message).toBe("Session was aborted"));

    fixtureValue.dispose();
  });
});
