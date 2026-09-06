import { applySnapshot, createStore, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";
import { RendererModels } from "../../../../src/renderer/RendererModels";
import { Message } from "../../../../src/renderer/models/Message";

describe("CakeChatCollectionStore", () => {
  it("uses the shared optimistic message lifecycle for the first Cake Chat message", async () => {
    let acceptPrompt!: () => void;
    const prompt = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          acceptPrompt = () => resolve("turn-1");
        }),
    );
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = new RendererModels();
    const { root, subject: store } = mountWithRendererClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { prompt } } as unknown as RendererClient,
    );
    const session = store.activeSession!;

    const submission = session.submit("Hello Cake");
    expect(session.parts).toEqual([
      expect.objectContaining({ text: "Hello Cake", deliveryState: "sending" }),
    ]);

    acceptPrompt();
    await submission;
    expect(session.parts).toEqual([
      expect.objectContaining({ text: "Hello Cake", deliveryState: "sending" }),
    ]);

    session.model.parts.push(
      Message.create({
        id: "canonical-user-1",
        kind: "text",
        role: "user",
        text: "Hello Cake",
        status: "complete",
      }),
    );
    expect(session.optimisticUserMessages.pending).toEqual([]);
    expect(session.parts).toEqual([
      expect.objectContaining({ id: "canonical-user-1", deliveryState: undefined }),
    ]);
    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("splits Cake Chat into independently focused pending sessions", () => {
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = new RendererModels();
    const { root, subject: store } = mountWithRendererClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      {} as RendererClient,
    );
    const firstSessionId = store.sessionId!;

    const split = store.splitFocused("x");

    expect(split?.sessionId).not.toBe(firstSessionId);
    expect(store.sessionLayoutStore.panes).toHaveLength(2);
    expect(store.sessionLayoutStore.focusedSessionId).toBe(split?.sessionId);
    expect(store.loadedSessions).toHaveLength(2);

    store.focusPane(store.sessionLayoutStore.panes[0]!.paneId);
    expect(store.sessionId).toBe(firstSessionId);

    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("deletes a resolved draft without calling the Cake Chat backend", async () => {
    const deleteResolved = vi.fn(async () => undefined);
    const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
    const models = new RendererModels();
    const { root, subject: store } = mountWithRendererClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { deleteResolved } } as unknown as RendererClient,
    );
    const sessionId = store.sessionId!;
    store.createDraftSession(sessionId, "Planned work", []);
    await store.resolveSession(sessionId, true);

    await store.deleteSession(sessionId);

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
    const models = new RendererModels();
    const { root, subject: store } = mountWithRendererClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { prompt } } as unknown as RendererClient,
    );
    const session = store.activeSession!;

    session.chatStore.addAnnotation({
      messageId: "assistant-1",
      entryId: "entry-1",
      selectedText: "important detail",
      startOffset: 6,
      endOffset: 22,
      contextBefore: "An ",
      contextAfter: " follows.",
      comment: "Explain this",
    });
    await session.chatStore.submit();

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
    expect(session.chatStore.annotations).toEqual([]);
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
    const models = new RendererModels();
    const { root, subject: store } = mountWithRendererClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { open } } as unknown as RendererClient,
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
    const models = new RendererModels();
    const { root, subject: store } = mountWithRendererClient(
      createStore(CakeChatCollectionStore, {
        catalog,
        sessionModel: (sessionId) => models.cakeChat(sessionId),
        tools: () => [],
      }),
      { cakeChats: { prompt } } as unknown as RendererClient,
    );

    const initialization = store.initialize();
    catalog.loaded = true;
    await initialization;
    const session = store.activeSession;
    expect(session).toBeDefined();

    await session!.submit("Hello Cake");

    expect(prompt).toHaveBeenNthCalledWith(
      1,
      {
        sessionId: session!.sessionId,
        text: "Hello Cake",
        renderUserMessageAsMarkdown: false,
        attachments: [],
        newSession: { tools: [] },
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
    expect(toSnapshot(store)).toMatchObject({ state: { pendingSessions: [] } });

    await session!.submit("Follow up");

    expect(prompt).toHaveBeenNthCalledWith(
      2,
      {
        sessionId: session!.sessionId,
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
