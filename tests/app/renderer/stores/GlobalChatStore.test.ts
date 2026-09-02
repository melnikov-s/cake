import { applySnapshot, createStore, toSnapshot } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { RendererClient } from "../../../../src/renderer/client/RendererClient";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { GlobalChatStore } from "../../../../src/renderer/stores/GlobalChatStore";
import { mountWithRendererClient } from "../mount-with-renderer-client";
import { RendererModels } from "../../../../src/renderer/RendererModels";

describe("GlobalChatStore", () => {
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
      createStore(GlobalChatStore, {
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
      createStore(GlobalChatStore, {
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
