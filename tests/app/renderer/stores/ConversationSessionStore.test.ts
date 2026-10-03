import { createStore, mount } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { Message } from "../../../../src/renderer/models/Message";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { ConversationSessionStore } from "../../../../src/renderer/stores/ConversationSessionStore";
import { SessionOperationCoordinatorStore } from "../../../../src/renderer/stores/SessionOperationCoordinatorStore";
import { mountWithClient } from "../mount-with-client";

function fixture(
  chatOverrides: Partial<ConversationSessionStore["props"]["chat"]> = {},
  profile: "project" | "cake-chat" = "project",
) {
  const models = RootProjection.create();
  const model =
    profile === "project"
      ? models.projectConversation("session-1", "/project")
      : models.cakeChatConversation("session-1");
  const operations = mount(createStore(SessionOperationCoordinatorStore));
  const deliver = vi.fn<(input: unknown, options?: unknown) => Promise<boolean>>(async () => true);
  const editMessage = vi.fn<(input: unknown, options?: unknown) => Promise<undefined>>(
    async () => undefined,
  );
  const setModel = vi.fn<(provider: string, modelId: string) => Promise<undefined>>(
    async () => undefined,
  );
  const abort = vi.fn<(input?: unknown, options?: unknown) => Promise<undefined>>(
    async () => undefined,
  );
  const rewordComposerSelection = vi.fn(async () => "Reworded");
  const client = {
    sessionChats: {
      prompt: deliver,
      steer: deliver,
      editMessage,
      compact: async () => undefined,
      clearQueue: async () => ({ steering: [], followUp: [] }),
      cancelSteering: async () => ({ steering: [], followUp: [] }),
      removeQueuedMessage: vi.fn(async () => ({ steering: [], followUp: [] })),
      steerQueuedMessage: vi.fn(async () => ({ steering: [], followUp: [] })),
      sendQueuedMessageNow: vi.fn(async () => ({ steering: [], followUp: [] })),
      setModel: async ({ provider, modelId }: { provider: string; modelId: string }) =>
        setModel(provider, modelId),
      setThinkingLevel: async () => undefined,
      setFastMode: async () => undefined,
      applyConfiguration: async () => undefined,
      setUserMessageMarkdown: async () => undefined,
      abort,
    },
    electron: { showComposerContextMenu: async () => "reword" },
    workspaces: { rewordComposerSelection },
  } as unknown as Client;
  const mounted = mountWithClient(
    createStore(ConversationSessionStore, {
      sessionId: "session-1",
      model,
      operations,
      canSubmit: () => true,
      ensureSessionActive: () => true,
      composer: {
        renameSession: async () => undefined,
        toolCompactSession: async () => false,
      },
      configuration: {},
      chat: {
        commands: () => model.commands,
        placeholder: () => "Ask Cake…",
        inputLabel: () => "Message",
        ...chatOverrides,
      },
      modelPresets: () => [],
      openModelPresetSettings: () => undefined,
    }),
    client,
  );
  return {
    ...mounted,
    client,
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

  it.each(["project", "cake-chat"] as const)(
    "routes shared delivery, queue, configuration, abort, edit, and reword capabilities for %s",
    async (profile) => {
      const fixtureValue = fixture({}, profile);
      const { subject, model, deliver, editMessage, setModel, abort, rewordComposerSelection } =
        fixtureValue;
      const chat = subject.chatStore;

      await chat.submit("Initial prompt");
      expect(deliver).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Initial prompt" }),
        expect.any(Object),
      );
      expect(subject.composerStore.deliveryStore.optimisticUserMessages.pending).toHaveLength(1);

      await subject.configurationStore.selectModel("openai/gpt-5");
      expect(setModel).toHaveBeenCalledWith("openai", "gpt-5");

      model.streaming = true;
      await chat.submit("Queued follow-up");
      expect(deliver).toHaveBeenCalledTimes(2);
      expect(chat.queuedPrompts).toEqual([
        expect.objectContaining({ text: "Queued follow-up", state: "queued", pending: true }),
      ]);

      model.parts.push(
        Message.create({
          id: "queued-steering-1",
          partKey: "queued-steering-1",
          piId: "queued-steering-1",
          kind: "text",
          role: "user",
          text: "Queued follow-up",
          status: "complete",
          deliveryState: "steering",
        }),
      );
      expect(chat.queuedPrompts).toEqual([
        expect.objectContaining({ id: "queued-steering-1", state: "steering" }),
      ]);
      model.parts.splice(0);

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
      expect(editMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "Edited" }),
        expect.any(Object),
      );

      await expect(chat.rewordComposerSelection("Rough wording")).resolves.toBe("Reworded");
      expect(rewordComposerSelection).toHaveBeenCalledWith(
        { selection: "Rough wording", prompt: undefined },
        expect.any(Object),
      );

      fixtureValue.dispose();
    },
  );

  // Queue ordering, editing, and cancellation are covered through the real Chat UI
  // and runtime projection in prompt-queue-workflow.test.tsx.

  it("surfaces a failed runtime queue edit as a composer error", async () => {
    const fixtureValue = fixture();
    fixtureValue.model.parts.push(
      Message.create({
        id: "queued-follow-up-abc-1",
        partKey: "queued-follow-up-abc-1",
        piId: "queued-follow-up-abc-1",
        kind: "text",
        role: "user",
        text: "Check the build",
        status: "complete",
        deliveryState: "queued",
      }),
    );
    Object.assign(fixtureValue.client.sessionChats, {
      removeQueuedMessage: async () => {
        throw new Error("Session was aborted");
      },
    });
    const { subject } = fixtureValue;

    subject.chatStore.removeQueuedPrompt("queued-follow-up-abc-1");
    await vi.waitFor(() => expect(subject.error.message).toBe("Session was aborted"));

    fixtureValue.dispose();
  });
});
