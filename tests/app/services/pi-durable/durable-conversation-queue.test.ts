import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { cakeChatSideChatSessionId } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { createDurableSideChats } from "../../../../src/services/pi-durable/durable-side-chats";
import {
  Harness,
  LiveDoc,
  MemoryStorage,
  createRegistry,
  type Conversation,
} from "@earendil-works/pi-durable";
import { createAssistantMessageEventStream, type Context } from "@earendil-works/pi-durable-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  encodeCrossSessionMessage,
  type CrossSessionMessageMetadata,
} from "../../../../src/contracts/conversations/cross-session-message";
import {
  abortDurableActiveTurn,
  createDurableConversationQueue,
} from "../../../../src/services/pi-durable/durable-chat-queue";
import {
  DURABLE_SIDE_CHAT_NOTE,
  durableInputPresentation,
  durableInputText,
} from "../../../../src/services/pi-durable/durable-input-presentation";
import { durableAnswer, durableModel, durableModels } from "../../../fixtures/durable-chat";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

/** Real SDK admission, transactions, inbox and settlement; only the provider is controlled. */
async function fixture(kind: "root" | "side-chat") {
  const { models } = durableModels();
  type Call = { signal: AbortSignal | undefined; finish: () => void };
  const calls: Call[] = [];
  const requests: Context[] = [];
  const waiting: Array<(call: Call) => void> = [];
  const ready: Call[] = [];
  const nextRequest = () => {
    const call = ready.shift();
    if (call) return Promise.resolve(call);
    const deferred = Promise.withResolvers<Call>();
    waiting.push(deferred.resolve);
    return deferred.promise;
  };
  let hold = false;
  vi.spyOn(models, "streamSimple").mockImplementation((_model, request, options) => {
    requests.push(structuredClone(request));
    const stream = createAssistantMessageEventStream();
    const message = durableAnswer("Done");
    const call = {
      signal: options?.signal,
      finish: () => stream.push({ type: "done", reason: "stop", message }),
    };
    calls.push(call);
    const waiter = waiting.shift();
    if (waiter) waiter(call);
    else ready.push(call);
    stream.push({ type: "start", partial: message });
    options?.signal?.addEventListener(
      "abort",
      () =>
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...message, stopReason: "aborted" },
        }),
      { once: true },
    );
    if (!hold) queueMicrotask(call.finish);
    return stream;
  });
  const storage = new MemoryStorage();
  const harness = await Harness.open(
    storage,
    { models, registry: createRegistry(), settings: { compaction: { enabled: false } } },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: "fixture", modelId: "fixture" } },
  });
  const seed = await root.submit({ type: "input", content: "Seed" }, context);
  const settled = await seed.wait(context);
  if (settled.status !== "done" || settled.type !== "input") throw new Error("Seed failed");
  await nextRequest();
  const side = await root.fork(settled.answer, { ownership: { kind: "ownerless" } }, context);
  hold = true;
  const conversation = kind === "root" ? root : side;
  let executing = ["active"];
  const queueFor = (target: Conversation, targetKind: "root" | "side-chat") =>
    createDurableConversationQueue({
      harness,
      conversation: target,
      storage,
      kind: targetKind,
      executingTurnIds: () => executing,
    });
  const queue = queueFor(conversation, kind);
  const submit = (
    text: string,
    requestId?: string,
    mode: "steer" | "followUp" = "followUp",
    target = conversation,
  ) =>
    target.submit(
      { type: "input", content: durableInputText(text, [], false), requestId, whenBusy: mode },
      context,
    );
  const active = await submit("Active", "active");
  const activeCall = await nextRequest();
  return {
    harness,
    storage,
    root,
    side,
    conversation,
    queue,
    operations: queue.operations,
    queueFor,
    submit,
    active,
    activeCall,
    calls,
    requests,
    nextRequest,
    live: () => harness.snapshot(LiveDoc, conversation.id, context),
    setExecuting: (ids: string[]) => {
      executing = ids;
    },
  };
}

const metadata: CrossSessionMessageMetadata = {
  version: 1,
  messageId: "10000000-0000-4000-8000-000000000001",
  threadId: "10000000-0000-4000-8000-000000000002",
  sequence: 1,
  expectsResponse: true,
  resultDelivery: "notification",
  sender: { sessionId: "sender", title: "Sender", kind: "project-session" },
};

describe.each(["root", "side-chat"] as const)("Durable %s queue", (kind) => {
  it("projects the same IDs, lane positions and correlated messages, and reorders within a lane", async () => {
    const f = await fixture(kind);
    await f.submit("First", "first");
    await f.submit("Steering", "steering", "steer");
    const correlated = encodeCrossSessionMessage("Keep correlation", metadata);
    await f.submit(correlated, "correlated");
    const anonymous = await f.submit("No request ID");
    const write = await f.conversation.submit(
      { type: "write", entry: { kind: "app.note", data: "not conversational" } },
      context,
    );
    const pending = await f.operations.pendingMessages();
    expect(pending.items).toEqual([
      expect.objectContaining({
        itemId: "first",
        partId: "queued-first",
        lane: "follow-up",
        position: 1,
        state: "queued",
        text: "First",
      }),
      expect.objectContaining({ itemId: "steering", lane: "steering", position: 1 }),
      expect.objectContaining({
        itemId: "correlated",
        position: 2,
        text: correlated,
        crossSession: metadata,
      }),
      expect.objectContaining({ itemId: String(anonymous.id), position: 3 }),
    ]);
    expect(await f.operations.listQueuedMessages()).toEqual({
      steering: ["Steering"],
      followUp: ["First", correlated, "No request ID"],
    });
    const reordered = await f.operations.reorderPendingMessage({
      itemId: "correlated",
      position: 1,
    });
    expect(reordered.items.map((item) => [item.itemId, item.position])).toEqual([
      ["correlated", 1],
      ["first", 2],
      ["steering", 1],
      [String(anonymous.id), 3],
    ]);
    await f.operations.reorderPendingMessage({ itemId: "correlated", position: 99 });
    expect((await f.operations.listQueuedMessages()).followUp).toEqual([
      "First",
      "No request ID",
      correlated,
    ]);
    expect((await f.queue.inbox()).some((item) => item.id === write.id)).toBe(true);
    expect((await f.live())?.run?.inputs).toEqual([f.active.id]);
  });

  it.each([false, true])(
    "delivers A, B, then C once in FIFO order with attachment references: %s",
    async (attached) => {
      const f = await fixture(kind);
      const b = await f.submit("B queued", "b");
      const attachments = attached
        ? [
            {
              kind: "input" as const,
              id: "20000000-0000-4000-8000-000000000003",
              name: "queued.png",
              mimeType: "image/png",
              byteLength: 100,
            },
          ]
        : [];
      const c = await f.conversation.submit(
        {
          type: "input",
          requestId: "c",
          whenBusy: "followUp",
          content: durableInputText("C queued", attachments, false),
        },
        context,
      );
      expect((await f.queue.inbox()).map((item) => item.mode)).toEqual(["followUp", "followUp"]);
      expect(await f.operations.listQueuedMessages()).toEqual({
        steering: [],
        followUp: ["B queued", "C queued"],
      });
      expect(f.requests).toHaveLength(2); // Seed and A; no early delivery of B or C.
      f.activeCall.finish();
      expect(await f.active.wait(context)).toMatchObject({ status: "done" });
      const bCall = await f.nextRequest();
      expect((await f.queue.inbox()).map((item) => item.id)).toEqual([c.id]);
      expect(JSON.stringify(f.requests.at(-1))).toContain("B queued");
      expect(JSON.stringify(f.requests.at(-1))).not.toContain("C queued");
      bCall.finish();
      expect(await b.wait(context)).toMatchObject({ status: "done" });
      const cCall = await f.nextRequest();
      const users = f.requests
        .at(-1)!
        .messages.filter((message) => message.role === "user")
        .map((message) => JSON.stringify(message.content))
        .join("\n");
      expect(users.indexOf("B queued")).toBeLessThan(users.indexOf("C queued"));
      expect(users.split("B queued")).toHaveLength(2);
      expect(users.split("C queued")).toHaveLength(2);
      if (attached) expect(users).toContain("queued.png");
      expect(await f.queue.inbox()).toEqual([]);
      cCall.finish();
      expect(await c.wait(context)).toMatchObject({ status: "done" });
    },
  );

  it("appends explicit promotions to the steering tail without reversing either lane", async () => {
    const f = await fixture(kind);
    await f.submit("B", "b");
    await f.submit("C", "c");
    await f.submit("First steer", "s1", "steer");
    await f.submit("Second steer", "s2", "steer");
    expect(await f.operations.steerQueuedMessage("queued-c")).toEqual({
      steering: ["First steer", "Second steer", "C"],
      followUp: ["B"],
    });
    // Repeating the same explicit action is not another insertion/reorder.
    await f.operations.steerQueuedMessage("queued-s1");
    expect(await f.operations.listQueuedMessages()).toEqual({
      steering: ["First steer", "Second steer", "C"],
      followUp: ["B"],
    });
    expect((await f.live())?.run?.inputs).toEqual([f.active.id]);
    expect(f.activeCall.signal?.aborted).toBe(false);
  });

  it("promotes and cancels queued inputs without canceling the active turn or writes", async () => {
    const f = await fixture(kind);
    const first = await f.submit("First", "first");
    const promoted = await f.conversation.submit(
      {
        type: "input",
        requestId: "promoted",
        content: [
          { type: "text", text: durableInputText("Promote", [], true) },
          { type: "text", text: kind === "side-chat" ? DURABLE_SIDE_CHAT_NOTE : "Second block" },
        ],
      },
      context,
    );
    const write = await f.conversation.submit(
      { type: "write", entry: { kind: "app.note", data: "keep" } },
      context,
    );
    expect(await f.operations.steerQueuedMessage("queued-promoted")).toEqual({
      steering: ["Promote"],
      followUp: ["First"],
    });
    const item = (await f.queue.inbox()).find((entry) => entry.id === promoted.id);
    if (!item || item.mode === "write" || typeof item.content === "string")
      throw new Error("Missing promoted blocks");
    expect(item.mode).toBe("steer");
    expect(
      item.content.map(
        (block) => block.type === "text" && durableInputPresentation(block.text).steering,
      ),
    ).toEqual([true, kind === "root"]);
    expect(await f.operations.cancelSteering()).toEqual({ steering: [], followUp: ["First"] });
    expect(await promoted.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect((await f.live())?.run?.inputs).toEqual([f.active.id]);
    expect(f.activeCall.signal?.aborted).toBe(false);
    expect(await f.operations.removeQueuedMessage("first")).toEqual({ steering: [], followUp: [] });
    expect(await first.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    const cleared = await f.submit("Clear me", "clear");
    await f.operations.clearQueue();
    expect(await cleared.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect((await f.queue.inbox()).map((entry) => entry.id)).toContain(write.id);
    f.activeCall.finish();
    expect(await f.active.wait(context)).toMatchObject({ status: "done" });
  });

  it.each(["selected", "oldest"] as const)(
    "sends %s now with original identity, correlation and settlement",
    async (selection) => {
      const f = await fixture(kind);
      const first = await f.submit("Retain", "first");
      const text = encodeCrossSessionMessage("Answer this", metadata);
      const selected = await f.conversation.submit(
        {
          type: "input",
          requestId: "selected",
          whenBusy: "steer",
          content: durableInputText(text, [], true, true),
        },
        context,
      );
      if (selection === "oldest") await f.operations.removeQueuedMessage("first");
      const retained = selection === "oldest" ? await f.submit("Retain", "retained") : first;
      const ids = ["active"];
      f.setExecuting(ids);
      const result = await f.operations.sendQueuedMessageNow(
        selection === "selected" ? "queued-selected" : undefined,
      );
      ids.push("later");
      expect(result).toEqual({
        queued: { steering: [], followUp: ["Retain"] },
        abortedTurnIds: ["active"],
      });
      expect(await f.active.wait(context)).toMatchObject({
        status: "unanswered",
        reason: "aborted",
      });
      const call = await f.nextRequest();
      expect((await f.live())?.run?.inputs).toEqual([selected.id]);
      const record = await f.storage.submission(selected.id, context);
      expect(record).toMatchObject({ status: "placed", requestId: "selected" });
      const originals = await f.conversation.context(context);
      const latest = originals.messages.findLast((message) => message.role === "user");
      expect(JSON.stringify(latest)).toContain("Answer this");
      expect(JSON.stringify(latest)).toContain(metadata.messageId);
      if (latest?.role !== "user") throw new Error("Missing selected input");
      const content =
        typeof latest.content === "string"
          ? latest.content
          : latest.content.find((part) => part.type === "text")?.text;
      expect(content && durableInputPresentation(content)).toMatchObject({
        markdown: true,
        steering: false,
      });
      call.finish();
      expect(await selected.wait(context)).toMatchObject({ status: "done" });
      const retainedCall = await f.nextRequest();
      retainedCall.finish();
      expect(await retained.wait(context)).toMatchObject({ status: "done" });
    },
  );

  it("rejects stale reorder/cancel/promote/send-now without disturbing the active turn", async () => {
    const f = await fixture(kind);
    const removed = await f.submit("Removed", "stale");
    await f.operations.removeQueuedMessage("queued-stale");
    expect(await removed.wait(context)).toMatchObject({ status: "unanswered", reason: "aborted" });
    for (const id of ["stale", "queued-stale", "active"]) {
      await expect(f.operations.reorderPendingMessage({ itemId: id, position: 1 })).rejects.toThrow(
        "no longer exists",
      );
      await expect(f.operations.removeQueuedMessage(id)).rejects.toThrow("no longer exists");
      await expect(f.operations.steerQueuedMessage(id)).rejects.toThrow("no longer exists");
      await expect(f.operations.sendQueuedMessageNow(id)).rejects.toThrow("no longer exists");
    }
    await expect(f.operations.sendQueuedMessageNow()).rejects.toThrow("No queued message");
    expect((await f.live())?.run?.inputs).toEqual([f.active.id]);
    expect(f.activeCall.signal?.aborted).toBe(false);
    f.activeCall.finish();
    expect(await f.active.wait(context)).toMatchObject({ status: "done" });
  });

  it.each(["reorder", "promote"] as const)(
    "rejects %s when withdrawal wins transaction admission, preserving the active turn",
    async (operation) => {
      const f = await fixture(kind);
      const queued = await f.submit("Withdraw before mutation", "withdrawn");
      const commit = f.conversation.commit.bind(f.conversation);
      vi.spyOn(f.conversation, "commit").mockImplementationOnce(async (body, ctx) => {
        await f.harness.abortSubmission(queued.id, context, f.conversation.id);
        return commit(body, ctx);
      });
      const mutation =
        operation === "reorder"
          ? f.operations.reorderPendingMessage({ itemId: "withdrawn", position: 1 })
          : f.operations.steerQueuedMessage("withdrawn");
      await expect(mutation).rejects.toThrow("already consumed");
      expect((await f.live())?.run?.inputs).toEqual([f.active.id]);
      expect(f.activeCall.signal?.aborted).toBe(false);
      f.activeCall.finish();
      expect(await f.active.wait(context)).toMatchObject({ status: "done" });
    },
  );

  it("keeps root and side-chat queues isolated even with matching request IDs", async () => {
    const f = await fixture(kind);
    const other = kind === "root" ? f.side : f.root;
    const otherQueue = f.queueFor(other, kind === "root" ? "side-chat" : "root");
    const otherActive = await f.submit("Other active", "other-active", "followUp", other);
    const otherCall = await f.nextRequest();
    await f.submit("Local", "shared");
    const otherQueued = await f.submit("Other queued", "shared", "followUp", other);
    await f.operations.steerQueuedMessage("shared");
    await f.operations.clearQueue();
    expect(await otherQueue.operations.pendingMessages()).toMatchObject({
      items: [{ itemId: "shared", text: "Other queued", lane: "follow-up", position: 1 }],
    });
    expect(otherCall.signal?.aborted).toBe(false);
    expect((await f.harness.snapshot(LiveDoc, other.id, context))?.run?.inputs).toEqual([
      otherActive.id,
    ]);
    expect((await otherQueue.inbox()).map((item) => item.id)).toEqual([otherQueued.id]);
  });

  it.each(["interrupt", "dispose"] as const)(
    "preserves durable queued work on owner %s",
    async (action) => {
      const f = await fixture(kind);
      const queued = await f.submit("Keep pending", "pending");
      if (action === "interrupt") {
        await abortDurableActiveTurn(f.harness, f.conversation);
        expect(await f.active.wait(context)).toMatchObject({
          status: "unanswered",
          reason: "aborted",
        });
        expect((await f.live())?.run).toBeUndefined();
      }
      expect((await f.queue.inbox()).map((item) => item.id)).toEqual([queued.id]);
      // A persistent adapter can be reopened after Harness shutdown. Keep this in-memory
      // adapter readable to inspect the authoritative records after the real shutdown.
      vi.spyOn(f.storage, "close").mockResolvedValue(undefined);
      await f.harness.close(context);
      expect(await f.storage.submission(queued.id, context)).toMatchObject({
        status: "queued",
        requestId: "pending",
      });
      expect((await f.storage.conversation(f.conversation.id, context))?.id).toBe(
        f.conversation.id,
      );
      expect(await f.storage.submission(f.active.id, context)).toMatchObject({
        status: action === "interrupt" ? "unanswered" : "placed",
      });
      expect(f.activeCall.signal?.aborted).toBe(true);
      expect(f.calls).toHaveLength(2);
    },
  );
});

it("disposing a side-chat runtime releases observation, not its shared Harness or accepted work", async () => {
  const f = await fixture("side-chat");
  const queued = await f.submit("Keep pending", "pending");
  const sideChats = createDurableSideChats({
    harness: f.harness,
    root: f.root,
    storage: f.storage,
    sessionFile: "/fixture/coordinator.sqlite",
    catalog: { getModel: () => durableModel },
    settings: SettingsManager.inMemory(),
    models: () => [],
    fastMode: () => false,
  });
  const runtime = await sideChats.open({
    cwd: "/fixture",
    trusted: true,
    agentDir: "/fixture/agent",
    sessionDir: "/fixture/side-chat",
    sessionId: cakeChatSideChatSessionId(f.side.id),
    requestUi: async () => undefined,
    onEvent: vi.fn(),
  });
  expect(await runtime.pendingMessages()).toEqual(await f.operations.pendingMessages());
  await runtime.dispose();
  await expect(runtime.prompt("Closed", "prompt", [])).rejects.toThrow("has closed");
  expect(f.activeCall.signal?.aborted).toBe(false);
  expect((await f.live())?.run?.inputs).toEqual([f.active.id]);
  expect((await f.queue.inbox()).map((item) => item.id)).toEqual([queued.id]);
  const rootInput = await f.submit("Root still works", "root", "followUp", f.root);
  const rootCall = await f.nextRequest();
  rootCall.finish();
  expect(await rootInput.wait(context)).toMatchObject({ status: "done" });
  f.activeCall.finish();
  expect(await f.active.wait(context)).toMatchObject({ status: "done" });
  const next = await f.nextRequest();
  next.finish();
  expect(await queued.wait(context)).toMatchObject({ status: "done" });
});
