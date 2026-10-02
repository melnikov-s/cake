// Migration backlog: observation demand, resolved-model restoration, attachment failures,
// optimistic transcript rendering, split panes, and annotations.
// Migrated management/command cases live in ../cake-chat-management-workflow.test.tsx.
import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { mountWithClient } from "../mount-with-client";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { Message } from "../../../../src/renderer/models/Message";

describe("CakeChatCollectionStore", () => {
  it("observes only visible or running loaded Cake Chats", () => {
    const catalog = CakeChatCatalog.create();
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChatConversation(sessionId),
        controlsModel: (sessionId) => models.controlsForCakeChat(sessionId),
        tools: () => [],
      }),
      {} as Client,
    );
    const first = store.registry.load("first");
    store.registry.load("second");
    store.sessionLayoutStore.ensureSession("first");
    store.sessionLayoutStore.showSession("second");

    expect(store.registry.observationTargets.map(({ sessionId }) => sessionId)).toEqual(["second"]);

    first.model.streaming = true;
    expect(store.registry.observationTargets.map(({ sessionId }) => sessionId)).toEqual([
      "first",
      "second",
    ]);

    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("restores a resolved Cake Chat before delivering a message or changing its model", async () => {
    const calls: string[] = [];
    const restore = vi.fn(async () => {
      calls.push("restore");
    });
    const prompt = vi.fn(async () => {
      calls.push("prompt");
    });
    const setModel = vi.fn(async () => {
      calls.push("model");
    });
    const catalog = CakeChatCatalog.create({
      loaded: true,
      sessions: [
        {
          sessionId: "resolved-chat",
          title: "Resolved chat",
          createdAt: new Date(0).toISOString(),
          modifiedAt: new Date(0).toISOString(),
          messageCount: 1,
          resolved: true,
        },
      ],
    });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChatConversation(sessionId),
        controlsModel: (sessionId) => models.controlsForCakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { restore }, sessionChats: { prompt, setModel } } as unknown as Client,
    );
    const session = store.registry.load("resolved-chat");

    const submission = session.conversationSessionStore.chatStore.submit("Continue");

    expect(session.conversationSessionStore.chatStore.parts).toEqual([
      expect.objectContaining({ text: "Continue", deliveryState: "sending" }),
    ]);
    expect(session.conversationSessionStore.chatStore.loading).toBe(true);
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();
    session.model.observedSnapshotRevision += 1;
    await expect(submission).resolves.toBe(true);

    expect(calls).toEqual(["restore", "prompt"]);
    expect(restore).toHaveBeenCalledWith(
      { sessionId: "resolved-chat", tools: [] },
      expect.anything(),
    );
    const selection =
      session.conversationSessionStore.configurationStore.selectModel("openai/gpt-5");
    await Promise.resolve();
    expect(setModel).not.toHaveBeenCalled();
    session.model.observedSnapshotRevision += 1;
    await selection;

    expect(calls).toEqual(["restore", "prompt", "restore", "model"]);
    expect(restore).toHaveBeenCalledTimes(2);
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it.each([
    ["/model provider/model", "setModel"],
    ["/compact", "compact"],
    ["Hello Cake", "prompt"],
    ["/name New title", "rename"],
  ] as const)("retains %s when %s fails", async (text, operation) => {
    const fail = vi.fn(async () => {
      throw new Error("Request failed");
    });
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChatConversation(sessionId),
        controlsModel: (sessionId) => models.controlsForCakeChat(sessionId),
        tools: () => [],
      }),
      (operation === "rename"
        ? { cakeChats: { rename: fail } }
        : { sessionChats: { [operation]: fail } }) as unknown as Client,
    );
    const session = store.activeSession!;
    store.pendingSessions.markMaterialized(session.sessionId);
    const image = {
      kind: "image" as const,
      name: "context.png",
      mimeType: "image/png",
      data: "image",
    };
    session.conversationSessionStore.composerStore.draftStore.attachments.push(image);
    expect(await session.conversationSessionStore.chatStore.submit(text)).toBe(false);
    expect(session.conversationSessionStore.composerStore.draftStore.attachments).toEqual([image]);
    expect(fail).toHaveBeenCalledOnce();
    expect(session.conversationSessionStore.chatStore.draft).toBe(text);
    expect(
      session.conversationSessionStore.composerStore.deliveryStore.optimisticUserMessages.pending,
    ).toEqual([]);
    expect(session.conversationSessionStore.composerStore.deliveryStore.activeOperations).toEqual(
      [],
    );
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("uses the shared optimistic message lifecycle for the first Cake Chat message", async () => {
    let acceptPrompt!: () => void;
    const prompt = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          acceptPrompt = () => resolve("turn-1");
        }),
    );
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChatConversation(sessionId),
        controlsModel: (sessionId) => models.controlsForCakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { start: prompt } } as unknown as Client,
    );
    const session = store.activeSession!;

    session.conversationSessionStore.chatStore.setDraft("Hello Cake");
    const submission = session.conversationSessionStore.chatStore.submit();
    expect(session.conversationSessionStore.composerStore.parts).toEqual([
      expect.objectContaining({ text: "Hello Cake", deliveryState: "sending" }),
    ]);

    acceptPrompt();
    await submission;
    expect(session.conversationSessionStore.composerStore.parts).toEqual([
      expect.objectContaining({ text: "Hello Cake", deliveryState: "sending" }),
    ]);

    session.model.parts.push(
      Message.create({
        id: "canonical-user-1",
        partKey: "canonical-user-1",
        kind: "text",
        role: "user",
        text: "Hello Cake",
        status: "complete",
      }),
    );
    expect(
      session.conversationSessionStore.composerStore.deliveryStore.optimisticUserMessages.pending,
    ).toEqual([]);
    expect(session.conversationSessionStore.composerStore.parts).toEqual([
      expect.objectContaining({ id: "canonical-user-1", deliveryState: undefined }),
    ]);
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("splits Cake Chat into independently focused pending sessions", () => {
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChatConversation(sessionId),
        controlsModel: (sessionId) => models.controlsForCakeChat(sessionId),
        tools: () => [],
      }),
      {} as Client,
    );
    const firstSessionId = store.sessionId!;

    const split = store.splitFocused("x");

    expect(split?.sessionId).not.toBe(firstSessionId);
    expect(store.sessionLayoutStore.panes).toHaveLength(2);
    expect(store.sessionLayoutStore.focusedSessionId).toBe(split?.sessionId);
    expect(store.registry.sessions).toHaveLength(2);

    store.focusPane(store.sessionLayoutStore.panes[0]!.paneId);
    expect(store.sessionId).toBe(firstSessionId);

    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("submits transcript annotations from Cake Chat", async () => {
    const prompt = vi.fn(async () => "turn-1");
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChatConversation(sessionId),
        controlsModel: (sessionId) => models.controlsForCakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { start: prompt } } as unknown as Client,
    );
    const session = store.activeSession!;

    session.conversationSessionStore.chatStore.addAnnotation({
      messageId: "assistant-1",
      entryId: "entry-1",
      selectedText: "important detail",
      startOffset: 6,
      endOffset: 22,
      contextBefore: "An ",
      contextAfter: " follows.",
      comment: "Explain this",
    });
    await session.conversationSessionStore.chatStore.submit();

    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "",
        attachments: [
          {
            kind: "annotation",
            annotations: [
              expect.objectContaining({
                messageId: "assistant-1",
                selectedText: "important detail",
                comment: "Explain this",
              }),
            ],
          },
        ],
      }),
      expect.any(Object),
    );
    expect(session.conversationSessionStore.chatStore.annotations).toEqual([]);
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });
});
