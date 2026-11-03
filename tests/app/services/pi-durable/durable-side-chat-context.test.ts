import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { estimateContextTokens } from "@earendil-works/pi-durable-ai/utils/estimate";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { ConversationSnapshot } from "../../../../src/contracts/conversations/session-contract";
import { createDurableSideChats } from "../../../../src/services/pi-durable/durable-side-chats";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

const context = BACKGROUND_CONTEXT;
const smallModel = { ...durableModel, id: "small", contextWindow: 64_000 };

it("projects real fork context, publishes arrivals/model changes, and restores metrics on reopening", async () => {
  const { models } = durableModels((_request, index) => {
    const message = durableAnswer("Reply");
    const totalTokens = [18_000, 28_200, 31_000, 32_000][index - 1];
    if (totalTokens === undefined) throw new Error("Unexpected provider request");
    return {
      ...message,
      timestamp: Date.now() + 1_000,
      usage: { ...message.usage, input: totalTokens - 100, output: 100, totalTokens },
    };
  });
  const directory = await mkdtemp(join(tmpdir(), "cake-side-chat-context-"));
  const database = join(directory, "chat.sqlite");
  let storage = await openNodeSqliteStorage(database);
  const registry = createRegistry();
  let harness = await Harness.open(storage, { models, registry }, context);
  const host = async () =>
    createDurableSideChats({
      harness,
      root: await harness.root(context),
      storage,
      sessionFile: "/chat.sqlite",
      catalog: {
        getModel: (_provider, id) => (id === "small" ? smallModel : durableModel),
      },
      settings: SettingsManager.inMemory(),
      models: () => [],
      fastMode: () => false,
    });
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "fixture", modelId: "fixture" } },
    });
    for (const text of ["Inherited first question", "Inherited second question"])
      await (await root.submit({ type: "input", content: text }, context)).wait(context);
    const parentBefore = await readDurableOriginalPage(root);
    const replies = parentBefore.parts.filter(
      (part) => part.kind === "text" && part.role === "assistant",
    );
    const reply = replies.at(-1);
    const entryId = reply?.kind === "text" ? reply.entryId : undefined;
    if (!entryId) throw new Error("Missing branch point");
    const chats = await host();
    const sessionId = await chats.fork(entryId);
    let arrival = Promise.withResolvers<ConversationSnapshot>();
    let expectedArrival = 31_000;
    const options = {
      sessionId,
      cwd: "/fixture",
      agentDir: "/agent",
      sessionDir: "/sessions",
      requestUi: async () => undefined,
      onEvent: (event: Parameters<Parameters<typeof chats.open>[0]["onEvent"]>[0]) => {
        if (event.type === "snapshot" && event.snapshot.usage?.context?.tokens === expectedArrival)
          arrival.resolve(event.snapshot);
      },
    };
    const runtime = await chats.open(options);
    try {
      const initial = await runtime.snapshot();
      expect(initial.parts).toEqual([]); // Inherited history is context, not side-chat dialogue.
      expect(initial.usage?.tokens.total).toBe(0);
      expect(initial.usage?.context).toEqual({
        tokens: 28_200,
        contextWindow: 200_000,
        percent: (28_200 / 200_000) * 100,
      });
      await runtime.prompt("Side-chat question", "prompt", []);
      expect((await arrival.promise).usage?.context?.tokens).toBe(31_000);
      expectedArrival = 32_000;
      arrival = Promise.withResolvers<ConversationSnapshot>();
      await runtime.prompt("Another side-chat question", "prompt", []);
      expect((await arrival.promise).usage?.context?.tokens).toBe(32_000);
      const after = await runtime.snapshot();
      expect(after.usage?.context?.tokens).toBe(32_000);
      expect(after.usage?.tokens.total).toBe(63_000);
      arrival = Promise.withResolvers<ConversationSnapshot>();
      await runtime.setModel("fixture", "small");
      expect((await arrival.promise).usage?.context).toEqual({
        tokens: 32_000,
        contextWindow: 64_000,
        percent: (32_000 / 64_000) * 100,
      });
      expect(await readDurableOriginalPage(root)).toEqual(parentBefore);
    } finally {
      await runtime.dispose();
    }
    await harness.close(context);
    storage = await openNodeSqliteStorage(database);
    harness = await Harness.open(storage, { models, registry }, context);
    const reopened = await (await host()).open(options);
    try {
      expect((await reopened.snapshot()).usage?.context).toEqual({
        tokens: 32_000,
        contextWindow: 64_000,
        percent: (32_000 / 64_000) * 100,
      });
    } finally {
      await reopened.dispose();
    }
  } finally {
    await harness.close(context);
    await rm(directory, { recursive: true, force: true });
  }
});

it("estimates inherited text without provider usage and reports unavailable context/model truthfully", async () => {
  const { models } = durableModels();
  const storage = new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
  try {
    const root = await harness.root(context, {
      agent: { model: { provider: "fixture", modelId: "fixture" } },
    });
    await (
      await root.submit({ type: "input", content: "Inherited detail. ".repeat(200) }, context)
    ).wait(context);
    const history = await readDurableOriginalPage(root);
    const reply = history.parts.find((part) => part.kind === "text" && part.role === "assistant");
    const entryId = reply?.kind === "text" ? reply.entryId : undefined;
    if (!entryId) throw new Error("Missing branch point");
    let selected = true;
    const chats = createDurableSideChats({
      harness,
      root,
      storage,
      sessionFile: "/chat.sqlite",
      catalog: { getModel: () => (selected ? durableModel : undefined) },
      settings: SettingsManager.inMemory(),
      models: () => [],
      fastMode: () => false,
    });
    const sessionId = await chats.fork(entryId);
    const expected = estimateContextTokens((await root.context(context)).messages).tokens;
    expect(expected).toBeGreaterThan(900);
    let failContext = false;
    const conversation = harness.conversation.bind(harness);
    vi.spyOn(harness, "conversation").mockImplementation(async (...args) => {
      const fork = await conversation(...args);
      if (fork) {
        const read = fork.context.bind(fork);
        vi.spyOn(fork, "context").mockImplementation((...args) =>
          failContext ? Promise.reject(new Error("Context unavailable")) : read(...args),
        );
      }
      return fork;
    });
    const runtime = await chats.open({
      sessionId,
      cwd: "/fixture",
      agentDir: "/agent",
      sessionDir: "/sessions",
      requestUi: async () => undefined,
      onEvent: () => undefined,
    });
    try {
      expect((await runtime.snapshot()).usage?.context?.tokens).toBe(expected);
      failContext = true;
      expect((await runtime.snapshot()).usage?.context).toEqual({
        tokens: null,
        contextWindow: 200_000,
        percent: null,
      });
      selected = false;
      expect((await runtime.snapshot()).usage?.context).toBeUndefined();
    } finally {
      await runtime.dispose();
    }
  } finally {
    await harness.close(context);
  }
});
