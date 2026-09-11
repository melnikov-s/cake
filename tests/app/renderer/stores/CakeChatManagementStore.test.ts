import { createStore } from "r-state-tree";
import { describe, expect, it, vi } from "vitest";
import type { Client } from "../../../../src/renderer/client/Client";
import { CakeChatCatalog } from "../../../../src/renderer/models/CakeChatCatalog";
import { RootProjection } from "../../../../src/renderer/models/RootProjection";
import { CakeChatCollectionStore } from "../../../../src/renderer/stores/CakeChatCollectionStore";
import { mountWithClient } from "../mount-with-client";

const mountCollection = (client: Client) => {
  const catalog = CakeChatCatalog.create({ loaded: true, sessions: [] });
  const models = RootProjection.create();
  const mounted = mountWithClient(
    createStore(CakeChatCollectionStore, {
      catalog,
      sessionModel: (sessionId) => models.cakeChat(sessionId),
      tools: () => [],
    }),
    client,
  );
  return { ...mounted, catalog, models };
};

describe("CakeChatManagementStore", () => {
  it("serializes resolution calls and continues the queue after a failure", async () => {
    let releaseFirst!: () => void;
    const calls: string[] = [];
    const resolve = vi.fn(({ sessionId }: { sessionId: string }) => {
      calls.push(`start:${sessionId}`);
      if (sessionId === "first")
        return new Promise<void>((_, reject) => {
          releaseFirst = () => reject(new Error("first failed"));
        });
      calls.push(`finish:${sessionId}`);
      return Promise.resolve();
    });
    const {
      root,
      subject: collection,
      catalog,
      models,
    } = mountCollection({
      cakeChats: { resolve },
    } as unknown as Client);

    const first = collection.management.resolveSession("first", true);
    const second = collection.management.resolveSession("second", true);
    await vi.waitFor(() => expect(calls).toEqual(["start:first"]));
    releaseFirst();
    await Promise.all([first, second]);

    expect(calls).toEqual(["start:first", "start:second", "finish:second"]);
    expect(collection.activeSession?.conversationSessionStore.composerStore.error).toContain(
      "first failed",
    );

    root[Symbol.dispose]();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });

  it("ignores a late toolCompact result after disposal", async () => {
    let finishToolCompact!: () => void;
    const toolCompact = vi.fn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          finishToolCompact = () => resolve({ sessionId: "late-session" });
        }),
    );
    const {
      root,
      subject: collection,
      catalog,
      models,
    } = mountCollection({
      cakeChats: { toolCompact },
    } as unknown as Client);

    const result = collection.management.toolCompact(collection.sessionId!, "entry-1");
    root[Symbol.dispose]();
    finishToolCompact();

    await expect(result).resolves.toBe(false);
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });
});
