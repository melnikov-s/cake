import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  Harness,
  MemoryStorage,
  createRegistry,
  type Conversation,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { Schema } from "effect";
import { ConversationHistoryPage } from "../../../../src/contracts/conversations/conversation-data";
import { cakeChatSideChatSessionId } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { createDurableSideChats } from "../../../../src/services/pi-durable/durable-side-chats";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

const context = BACKGROUND_CONTEXT;

it.each(["memory", "sqlite"] as const)(
  "pages %s fork originals across local and parent boundaries, at the exact cutoff",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "side-chat-pages-"));
    const storage =
      kind === "memory"
        ? new MemoryStorage()
        : await openNodeSqliteStorage(join(directory, "chat.sqlite"));
    const { models } = durableModels();
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
    try {
      const root = await harness.root(context);
      const empty = await readDurableOriginalPage(root);
      expect(empty).toEqual({ parts: [] });
      expect(() => Schema.encodeSync(ConversationHistoryPage)(empty)).not.toThrow();
      const append = (chat: Conversation, prefix: string, count: number) =>
        chat.commit(async (tx) => {
          const entries = [];
          for (let index = 0; index < count; index++)
            entries.push(
              await tx.appendEntry(chat.id, {
                kind: "pi.user",
                model: [{ role: "user", content: `${prefix} ${index}`, timestamp: index + 1 }],
              }),
            );
          return entries;
        }, context);
      const inherited = await append(root, "parent", 650);
      const cutoff = inherited.at(-1);
      if (!cutoff) throw new Error("Missing cutoff");
      const chats = createDurableSideChats({
        harness,
        root,
        storage,
        sessionFile: "/chat.sqlite",
        catalog: { getModel: () => undefined },
        settings: SettingsManager.inMemory(),
        models: () => [],
        fastMode: () => false,
      });
      const side = await root.fork(cutoff.id, { ownership: { kind: "ownerless" } }, context);
      const sessionId = cakeChatSideChatSessionId(side.id);
      await append(root, "LATER PARENT MUST NOT LEAK", 3);
      // Open through the production side-chat adapter; not a duplicate fork reader.
      const runtime = await chats.open({
        sessionId,
        cwd: directory,
        agentDir: directory,
        sessionDir: directory,
        requestUi: async () => undefined,
        onEvent: () => undefined,
      });
      try {
        const initial = await runtime.snapshot();
        expect(initial.parts).toHaveLength(200);
        expect(initial.parts.every((p) => p.originalHistory)).toBe(true);
        expect(initial.historyCursor).toBeDefined();
        await append(side, "side", 230);
        const latest = await runtime.snapshot();
        expect(latest.parts).toHaveLength(200);
        expect(latest.parts.every((p) => !p.originalHistory)).toBe(true);
        if (!runtime.history) throw new Error("Missing history capability");
        let cursor = latest.historyCursor;
        let parts = latest.parts;
        const pages = [];
        while (cursor !== undefined) {
          const page = await runtime.history(cursor);
          expect(() => Schema.encodeSync(ConversationHistoryPage)(page)).not.toThrow();
          expect(page.cursor).not.toBe(cursor);
          pages.push(page);
          parts = [...page.parts, ...parts];
          cursor = page.cursor;
        }
        expect(pages).toHaveLength(4);
        expect(parts.map((p) => (p.kind === "text" ? p.text : p.kind))).toEqual([
          ...Array.from({ length: 650 }, (_, i) => `parent ${i}`),
          ...Array.from({ length: 230 }, (_, i) => `side ${i}`),
        ]);
        expect(new Set(parts.map((p) => p.id)).size).toBe(880);
        expect(parts.filter((p) => p.originalHistory)).toHaveLength(650);
        expect(parts.slice(650).every((p) => !p.originalHistory)).toBe(true);
      } finally {
        await runtime.dispose();
      }
    } finally {
      await harness.close(context);
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("rejects repeated cursors while skipping invisible originals or looking up attribution instead of hanging", async () => {
  const { models } = durableModels();
  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry: createRegistry() },
    context,
  );
  try {
    const root = await harness.root(context);
    await root.commit(async (tx) => {
      for (let i = 0; i < 201; i++)
        await tx.appendEntry(root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: `input ${i}`, timestamp: i }],
        });
    }, context);
    const page = await root.entries({}, 200, undefined, context);
    expect(page.next).toBeDefined();
    const first = page.items[0];
    if (!first) throw new Error("Missing original");
    // Attribution lookback is needed for replies, not empty/invisible-only pages.
    const entries = vi.fn<Conversation["entries"]>().mockResolvedValue({
      items: [{ ...first, kind: "pi.assistant", model: [durableAnswer("Reply")] }],
      next: page.next,
    });
    await expect(readDurableOriginalPage({ entries })).rejects.toThrow(
      "attribution did not advance",
    );
    expect(entries).toHaveBeenCalledTimes(2);
    entries.mockResolvedValue({
      items: [{ ...first, kind: "invisible.metadata" }],
      next: page.next,
    });
    entries.mockClear();
    await expect(readDurableOriginalPage({ entries })).rejects.toThrow(
      "Earlier history did not advance",
    );
    expect(entries).toHaveBeenCalledTimes(2);
    entries.mockClear();
    await expect(readDurableOriginalPage({ entries }, JSON.stringify(page.next))).rejects.toThrow(
      "Earlier history did not advance",
    );
    expect(entries).toHaveBeenCalledOnce();
  } finally {
    await harness.close(context);
  }
});
