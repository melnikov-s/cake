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

  it("ignores a late handoff result after disposal", async () => {
    let finishHandoff!: () => void;
    const handoff = vi.fn(
      () =>
        new Promise<{ sessionId: string }>((resolve) => {
          finishHandoff = () => resolve({ sessionId: "late-session" });
        }),
    );
    const open = vi.fn(async () => undefined);
    const {
      root,
      subject: collection,
      catalog,
      models,
    } = mountCollection({
      cakeChats: { handoff, open },
    } as unknown as Client);

    const result = collection.management.handoff(collection.sessionId!, "entry-1");
    root[Symbol.dispose]();
    finishHandoff();

    await expect(result).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
    catalog[Symbol.dispose]();
    models[Symbol.dispose]();
  });
});
