import { applySnapshot, createStore, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import { SESSION_TITLE_MAX_LENGTH } from "../../../../src/ipc/session-contract";
import type { Client } from "../../../../src/renderer/client/Client";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { mountWithClient } from "../mount-with-client";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { Message } from "../../../../src/renderer/models/Message";

describe("CakeChatCollectionStore", () => {
  it("restores a resolved Cake Chat before delivering its next message", async () => {
    const calls: string[] = [];
    const restore = vi.fn(async () => {
      calls.push("restore");
    });
    const prompt = vi.fn(async () => {
      calls.push("prompt");
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
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { restore, prompt } } as unknown as Client,
    );
    const session = store.registry.load("resolved-chat");
    session.model.resolved = true;

    const submission = session.conversationSessionStore.chatStore.submit("Continue");

    expect(session.conversationSessionStore.chatStore.parts).toEqual([
      expect.objectContaining({ text: "Continue", deliveryState: "sending" }),
    ]);
    expect(session.conversationSessionStore.chatStore.loading).toBe(true);
    await Promise.resolve();
    expect(prompt).not.toHaveBeenCalled();

    session.model.resolved = false;
    session.model.observedSnapshotRevision += 1;
    await expect(submission).resolves.toBe(true);

    expect(calls).toEqual(["restore", "prompt"]);
    expect(restore).toHaveBeenCalledWith(
      { sessionId: "resolved-chat", tools: [] },
      expect.anything(),
    );
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it.each(["/model invalid", "/handoff continue", "/name"])(
    "retains rejected Cake Chat command %s for correction",
    async (command) => {
      const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
      const models = RootProjection.create();
      const { root, subject: store } = mountWithClient(
        createStore(CakeChatCollectionStore, {
          catalog,
          sessionModel: (sessionId) => models.cakeChat(sessionId),
          tools: () => [],
        }),
        {} as Client,
      );
      const session = store.activeSession!;
      const submitted = await session.conversationSessionStore.chatStore.submit(command);
      expect(submitted).toBe(false);
      expect(session.conversationSessionStore.chatStore.draft).toBe(command);
      expect(session.conversationSessionStore.composerStore.error).toBeDefined();
      root[Symbol.dispose]();
      catalog[Symbol.dispose]();
      models[Symbol.dispose]();
    },
  );

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
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { [operation]: fail } } as unknown as Client,
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

  it("reports failed saved-draft activation and retains its content for retry", async () => {
    const prompt = vi.fn(async () => {
      throw new Error("Send failed");
    });
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { prompt } } as unknown as Client,
    );
    const session = store.activeSession!;
    store.pendingSessions.conversation(session.sessionId)!.createDraft("Saved message", []);
    expect(await session.conversationSessionStore.chatStore.activateDraft()).toBe(false);
    expect(session.conversationSessionStore.chatStore.draft).toBe("Saved message");
    expect(
      session.conversationSessionStore.composerStore.deliveryStore.optimisticUserMessages.pending,
    ).toEqual([]);
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
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { prompt } } as unknown as Client,
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
        sessionModel: (sessionId) => models.cakeChat(sessionId),
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

  it("uses the shared composer command handling to rename Cake Chat", async () => {
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      {} as Client,
    );
    const session = store.activeSession!;

    await session.conversationSessionStore.chatStore.submit("/name Shared composer title");

    expect(store.summaries).toMatchObject([
      { sessionId: session.sessionId, title: "Shared composer title" },
    ]);
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("caps Cake Chat titles when renaming", async () => {
    const rename = vi.fn(async () => undefined);
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { rename } } as unknown as Client,
    );
    const sessionId = store.sessionId!;
    store.pendingSessions.markMaterialized(sessionId);

    await store.management.renameSession(sessionId, "x".repeat(SESSION_TITLE_MAX_LENGTH + 20));

    expect(rename).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        name: "x".repeat(SESSION_TITLE_MAX_LENGTH),
      }),
      expect.anything(),
    );
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("deletes a resolved draft without calling the Cake Chat backend", async () => {
    const deleteResolved = vi.fn(async () => undefined);
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { deleteResolved } } as unknown as Client,
    );
    const sessionId = store.sessionId!;
    store.pendingSessions.conversation(sessionId)!.createDraft("Planned work", []);
    await store.management.resolveSession(sessionId, true);

    await store.management.deleteSession(sessionId);

    expect(deleteResolved).not.toHaveBeenCalled();
    expect(store.summaries.some((session) => session.sessionId === sessionId)).toBe(false);
    expect(store.sessionId).toBeUndefined();
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
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { prompt } } as unknown as Client,
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

  it("keeps the latest selection when session opens finish out of order", async () => {
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    const open = vi.fn(({ sessionId }: { sessionId: string }) =>
      sessionId === "first" ? first : second,
    );
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { open } } as unknown as Client,
    );

    const openingFirst = store.open("first");
    expect(store.sessionId).toBe("first");
    const openingSecond = store.open("second");
    expect(store.sessionId).toBe("second");

    finishFirst();
    await openingFirst;
    expect(store.sessionId).toBe("second");
    finishSecond();
    await openingSecond;
    expect(store.sessionId).toBe("second");

    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("omits unset optional fields from Cake Chat prompts", async () => {
    const prompt = vi.fn(async () => "turn-1");
    const catalog = CakeChatCatalog.create({ loaded: false, sessions: [] });
    const models = RootProjection.create();
    const { root, subject: store } = mountWithClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { prompt } } as unknown as Client,
    );

    const initialization = store.initialize();
    catalog.loaded = true;
    await initialization;
    const session = store.activeSession;
    expect(session).toBeDefined();

    await session!.conversationSessionStore.chatStore.submit("Hello Cake");

    expect(prompt).toHaveBeenNthCalledWith(
      1,
      {
        sessionId: session!.sessionId,
        tools: [],
        text: "Hello Cake",
        renderUserMessageAsMarkdown: false,
        attachments: [],
        newSession: {},
      },
      expect.any(Object),
    );
    expect(store.summaries).toMatchObject([
      { sessionId: session!.sessionId, title: "New chat", messageCount: 1 },
    ]);

    applySnapshot(catalog, {
      loaded: true,
      sessions: [
        {
          sessionId: session!.sessionId,
          title: "Authoritative title",
          createdAt: "2026-09-02T10:00:00.000Z",
          modifiedAt: "2026-09-02T10:01:00.000Z",
          messageCount: 1,
          resolved: false,
        },
      ],
    });
    expect(store.summaries).toMatchObject([
      { sessionId: session!.sessionId, title: "Authoritative title", messageCount: 1 },
    ]);
    expect(toSnapshot(store)).toMatchObject({
      children: {
        pendingSessions: {
          state: { conversationIds: [], pendingSessionIds: [] },
          children: { conversations: [] },
        },
      },
    });

    await session!.conversationSessionStore.chatStore.submit("Follow up");

    expect(prompt).toHaveBeenNthCalledWith(
      2,
      {
        sessionId: session!.sessionId,
        tools: [],
        text: "Follow up",
        renderUserMessageAsMarkdown: false,
        attachments: [],
      },
      expect.any(Object),
    );
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });
});
