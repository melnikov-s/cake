import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
  ToolResultEntry,
  UserEntry,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDurableChatMemory,
  type DurableMemoryOptions,
} from "../../../../src/services/pi-durable/durable-chat-memory";
import { durableMemoryWork } from "../../../../src/services/pi-durable/durable-memory-work";
import { MEMORY_INPUT_BYTES } from "../../../../src/services/pi-durable/durable-memory-policy";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
const StoredNode = Schema.decodeUnknownSync(
  Schema.Struct({ n: Schema.Number, text: Schema.String }),
);
const inputText = (context: string) =>
  context.slice(context.indexOf("<input>\n") + 8, context.lastIndexOf("\n</input>"));
async function fixture(storage: Storage = new MemoryStorage(), budget = 4_000) {
  const harness = await Harness.open(
    storage,
    {
      models: durableModels().models,
      registry: createRegistry(),
      settings: { contextRetentionMs: 0 },
    },
    BACKGROUND_CONTEXT,
  );
  cleanup.push(() => harness.close(BACKGROUND_CONTEXT));
  const root = await harness.root(BACKGROUND_CONTEXT);
  const summarize = vi.fn<DurableMemoryOptions["summarize"]>(async ({ context }) => {
    const input = inputText(context);
    const marker = /RAW_([A-Z])/.exec(input)?.[1];
    return `${marker ? `summary-${marker}` : "merged-summary"}: ${"s".repeat(290)}`;
  });
  const memory = createDurableChatMemory(harness, root, storage, {
    budget: () => budget,
    summarize,
  });
  return {
    harness,
    root,
    memory,
    summarize,
    async append(text: string) {
      return root.commit(
        (tx) =>
          tx.appendEntry(UserEntry, root.id, {
            model: [{ role: "user", content: text, timestamp: 1 }],
          }),
        BACKGROUND_CONTEXT,
      );
    },
    async nodes() {
      const entries = [];
      let cursor;
      do {
        const page = await root.entries({ order: "ascending" }, 64, cursor, BACKGROUND_CONTEXT);
        entries.push(...page.items.filter((entry) => entry.kind === "cake.chat-memory-node/v1"));
        cursor = page.next;
      } while (cursor !== undefined);
      return entries;
    },
    view: () => memory.synchronize(signal()),
  };
}

it("indexes dialogue text without tool traffic or reasoning and preserves complete originals", async () => {
  const f = await fixture();
  await f.append("Remember the decision");
  const originals = await f.root.commit(async (tx) => {
    const call = {
      type: "toolCall" as const,
      id: "call-1",
      name: "inspect",
      arguments: { secret: "TOOL_ARGUMENT" },
    };
    const toolOnly = await tx.appendEntry(AssistantEntry, f.root.id, {
      model: [durableAnswer("", [call, { type: "thinking", thinking: "PRIVATE_REASONING" }])],
    });
    const result = await tx.appendEntry(ToolResultEntry, f.root.id, {
      data: { diagnostics: [] },
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "inspect",
          content: [{ type: "text", text: "TOOL_RESULT ".repeat(200) }],
          isError: false,
          timestamp: 1,
        },
      ],
    });
    const mixed = await tx.appendEntry(AssistantEntry, f.root.id, {
      model: [
        durableAnswer("", [
          { type: "text", text: "We chose the dialogue-only policy. ".repeat(40) },
          call,
          { type: "thinking", thinking: "PRIVATE_REASONING" },
        ]),
      ],
    });
    await tx.appendEntry(AssistantEntry, f.root.id, {
      model: [{ ...durableAnswer("   "), errorMessage: "ERROR_METADATA" }],
    });
    return { toolOnly, result, mixed };
  }, BACKGROUND_CONTEXT);
  const before = await f.root.context(BACKGROUND_CONTEXT);
  const view = await f.view();
  expect(view.sourceCount).toBe(2);
  expect(f.summarize).toHaveBeenCalledOnce();
  expect(inputText(f.summarize.mock.calls[0]![0].context)).toBe(
    `talk: ${"We chose the dialogue-only policy. ".repeat(40)}`,
  );
  const zoom = await f.memory.zoom(1, 1, signal());
  expect(zoom.text).toContain("talk: We chose the dialogue-only policy.");
  expect(zoom.text).not.toMatch(/TOOL_ARGUMENT|TOOL_RESULT|PRIVATE_REASONING|ERROR_METADATA/);
  expect(zoom.messages).toEqual(originals.mixed.model);
  // Neither indexing nor zoom rewrites the live context or the stored originals.
  expect((await f.root.context(BACKGROUND_CONTEXT)).messages).toEqual(before.messages);
  expect(
    await f.root.entries(
      { minEntryId: originals.toolOnly.id, maxEntryId: originals.toolOnly.id },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    ),
  ).toMatchObject({ items: [originals.toolOnly] });
  expect(
    await f.root.entries(
      { minEntryId: originals.result.id, maxEntryId: originals.result.id },
      1,
      undefined,
      BACKGROUND_CONTEXT,
    ),
  ).toMatchObject({ items: [originals.result] });
  await f.view();
  expect(f.summarize).toHaveBeenCalledOnce();
});

it("advances across pages of tool-only entries and indexes subsequent dialogue exactly once", async () => {
  const f = await fixture();
  await f.append("First request");
  for (let i = 0; i < 70; i += 1)
    await f.root.commit(
      (tx) =>
        tx.appendEntry(AssistantEntry, f.root.id, {
          model: [
            durableAnswer("", [
              {
                type: "toolCall",
                id: `call-${i}`,
                name: "inspect",
                arguments: { payload: "large tool arguments ".repeat(100) },
              },
            ]),
          ],
        }),
      BACKGROUND_CONTEXT,
    );
  expect(
    await f.memory.synchronize(signal(), undefined, undefined, { maxOriginals: 1 }),
  ).toMatchObject({ sourceCount: 1, complete: true });
  await f.append("Second request");
  expect(await f.view()).toMatchObject({ sourceCount: 2, complete: true });
  expect((await f.memory.zoom(1, 1, signal())).text).toContain("user: Second request");
  expect(f.summarize).not.toHaveBeenCalled();
});

it("persists one-original slices, indexes only new raw input, and merges existing summaries", async () => {
  const f = await fixture();
  await f.append("RAW_A ".repeat(100));
  await f.append("RAW_B ".repeat(100));
  const first = await f.memory.synchronize(signal(), undefined, undefined, { maxOriginals: 1 });
  expect(first).toMatchObject({ sourceCount: 1, complete: false });
  expect(f.summarize).toHaveBeenCalledOnce();
  expect(await f.view()).toMatchObject({ sourceCount: 2, complete: true });
  const payloads = f.summarize.mock.calls.map(([input]) => inputText(input.context));
  expect(payloads).toHaveLength(3);
  expect(payloads[0]).toContain("RAW_A");
  expect(payloads[1]).toContain("RAW_B");
  expect(payloads[2]).toContain("summary-A");
  expect(payloads[2]).toContain("summary-B");
  expect(payloads[2]).not.toContain("RAW_");
  await f.view();
  expect(f.summarize).toHaveBeenCalledTimes(3);
  expect((await f.memory.zoom(0, 1, signal())).text).toContain("RAW_A ".repeat(100));
});

it("persists each built node on mid-merge failure and resumes across SQLite reopen without rebuilding leaves or children", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-memory-merge-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "memory.sqlite");
  const first = await fixture(await openNodeSqliteStorage(database));
  for (const marker of ["A", "B", "C"]) await first.append(`RAW_${marker} `.repeat(100));
  expect((await first.view()).sourceCount).toBe(3);
  const committed = await first.nodes();
  expect(committed).toHaveLength(4);
  await first.append("RAW_D ".repeat(100));
  const interrupted = new AbortController();
  first.summarize
    .mockResolvedValueOnce("summary-D: " + "d".repeat(290))
    .mockResolvedValueOnce("merged-CD: " + "m".repeat(290))
    .mockImplementationOnce(() => {
      interrupted.abort(new Error("fixture interruption at final carry"));
      return new Promise<string>(() => undefined);
    });
  await expect(first.memory.synchronize(interrupted.signal)).rejects.toThrow(
    "fixture interruption at final carry",
  );
  expect(await first.nodes()).toHaveLength(committed.length + 2);
  expect((await first.memory.zoom(2, 1, signal())).text).toContain("RAW_C");
  expect((await first.memory.zoom(3, 1, signal())).text).toContain("RAW_D");
  await first.harness.close(BACKGROUND_CONTEXT);
  cleanup.pop();

  const reopened = await fixture(await openNodeSqliteStorage(database));
  expect((await reopened.view()).sourceCount).toBe(4);
  expect(reopened.summarize).toHaveBeenCalledOnce(); // Only the unfinished root, from built children.
  const payloads = reopened.summarize.mock.calls.map(([input]) => inputText(input.context));
  expect(payloads.join(" ")).not.toContain("RAW_");
  expect(await reopened.nodes()).toHaveLength(7);
  expect((await reopened.memory.zoom(0, 1, signal())).text).toContain("RAW_A");
  expect((await reopened.memory.zoom(3, 1, signal())).text).toContain("RAW_D");
  await reopened.view();
  expect(reopened.summarize).toHaveBeenCalledOnce();
});

it("derives bounded original anchors through view consolidation, zoom and SQLite reopen without rebuilding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-memory-anchors-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "memory.sqlite");
  const first = await fixture(await openNodeSqliteStorage(database), 900);
  const originals: Awaited<ReturnType<typeof first.append>>[] = [];
  for (const marker of ["A", "B", "C", "D"]) {
    originals.push(await first.append(`RAW_${marker} `.repeat(100)));
    if (marker === "A")
      await first.root.commit(
        (tx) =>
          tx.appendEntry(ToolResultEntry, first.root.id, {
            data: { diagnostics: [] },
            model: [
              {
                role: "toolResult",
                toolCallId: "between",
                toolName: "inspect",
                content: [{ type: "text", text: "intervening tool evidence" }],
                isError: false,
                timestamp: 2,
              },
            ],
          }),
        BACKGROUND_CONTEXT,
      );
  }
  const anchor = (start: number, end: number) =>
    `[originals=${originals[start]!.id}..${originals[end]!.id}]`;
  const view = await first.view();
  expect(view).toMatchObject({ complete: true, sourceCount: 4, partCount: 1 });
  expect(view.text).toContain(`0+4|${anchor(0, 3)}`);
  expect(view.bytes).toBe(Buffer.byteLength(view.text));
  expect(view.bytes).toBeLessThanOrEqual(900);
  expect((await first.memory.zoom(0, 4, signal())).text.split("\n")).toEqual([
    expect.stringContaining(`0+2|${anchor(0, 1)}`),
    expect.stringContaining(`2+2|${anchor(2, 3)}`),
  ]);
  expect((await first.memory.zoom(0, 2, signal())).text.split("\n")).toEqual([
    expect.stringContaining(`0+1|${anchor(0, 0)}`),
    expect.stringContaining(`1+1|${anchor(1, 1)}`),
  ]);
  expect((await first.memory.zoom(0, 1, signal())).text).toContain(
    `0+0|${anchor(0, 0)} user: RAW_A`,
  );
  const stored = await first.nodes();
  const head = await first.root.context(BACKGROUND_CONTEXT);
  await first.harness.close(BACKGROUND_CONTEXT);
  cleanup.pop();
  const reopened = await fixture(await openNodeSqliteStorage(database), 900);
  expect(await reopened.view()).toEqual(view);
  expect((await reopened.memory.zoom(0, 4, signal())).text).toContain(anchor(0, 1));
  expect((await reopened.memory.zoom(3, 1, signal())).text).toContain(anchor(3, 3));
  expect(reopened.summarize).not.toHaveBeenCalled();
  expect(await reopened.nodes()).toEqual(stored);
  expect((await reopened.root.context(BACKGROUND_CONTEXT)).messages).toEqual(head.messages);
});

it("retries a failed summary once, then keeps a bounded verbatim excerpt instead of stalling", async () => {
  const f = await fixture();
  await f.append("RAW_B ".repeat(100));
  f.summarize.mockResolvedValue("");
  expect((await f.view()).sourceCount).toBe(1);
  expect(f.summarize).toHaveBeenCalledTimes(2);
  const { text } = StoredNode((await f.nodes())[0]?.data);
  expect(text.startsWith("[excerpt; summary unavailable] user: RAW_B RAW_B")).toBe(true);
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(512);
  expect((await f.memory.zoom(0, 1, signal())).text).toContain("RAW_B ".repeat(100));
  f.summarize.mockResolvedValue("valid summary");
  await f.append("RAW_C ".repeat(100));
  expect((await f.view()).sourceCount).toBe(2); // Later originals keep indexing.
});

it("keeps verbatim text from both children when a merge summary keeps failing", async () => {
  const f = await fixture();
  const merge = f.summarize.getMockImplementation()!;
  f.summarize.mockImplementation(async (input) => {
    if (!inputText(input.context).includes("RAW_")) throw new Error("tool call instead of text");
    return merge(input);
  });
  await f.append("RAW_A ".repeat(100));
  await f.append("RAW_B ".repeat(100));
  const view = await f.view();
  expect(view.sourceCount).toBe(2);
  const parent = (await f.nodes()).map((entry) => StoredNode(entry.data)).find(({ n }) => n === 2)!;
  expect(parent.text).toContain("summary-A");
  expect(parent.text).toContain("summary-B");
  expect(Buffer.byteLength(parent.text)).toBeLessThanOrEqual(512);
});

it("bounds one oversized original to a single-request input with its head and tail", async () => {
  const f = await fixture();
  const original = `HEAD_MARK ${"x".repeat(300_000)} TAIL_MARK`;
  await f.append(original);
  expect((await f.view()).sourceCount).toBe(1);
  const input = inputText(f.summarize.mock.calls[0]![0].context);
  expect(Buffer.byteLength(input)).toBeLessThan(MEMORY_INPUT_BYTES + 100);
  expect(input).toContain("HEAD_MARK");
  expect(input).toContain("TAIL_MARK");
  expect(input).toContain("bytes omitted; zoom for the original");
  expect((await f.memory.zoom(0, 1, signal())).text).toContain(original);
});

it("uses a 512-byte ruler and same-conversation shortening feedback, retaining the shortest of five attempts", async () => {
  const f = await fixture();
  await f.append("RAW_A ".repeat(100));
  const shortest = "界".repeat(171); // 513 bytes: spec permits slight oversize after five attempts.
  for (const text of ["a".repeat(700), "b".repeat(600), shortest, "c".repeat(650), "d".repeat(800)])
    f.summarize.mockResolvedValueOnce(text);
  expect((await f.view()).sourceCount).toBe(1);
  expect(f.summarize.mock.calls.map(([input]) => input.previous?.length)).toEqual([0, 2, 4, 6, 8]);
  expect(f.summarize.mock.calls[0]![0].context).toContain("-".repeat(512));
  expect(f.summarize.mock.calls[3]![0].previous?.at(-1)?.text).toContain("513 bytes");
  expect((await f.nodes())[0]?.data).toMatchObject({ text: shortest });
  expect((await f.memory.zoom(0, 1, signal())).text).toContain("RAW_A ".repeat(100));
});

it("accepts exactly 512 UTF-8 bytes and enforces that bound on both leaves and merges", async () => {
  const f = await fixture();
  const exact = "界".repeat(170) + "ab";
  f.summarize.mockResolvedValue(exact);
  await f.append("RAW_A ".repeat(100));
  await f.append("RAW_B ".repeat(100));
  expect((await f.view()).sourceCount).toBe(2);
  expect(f.summarize).toHaveBeenCalledTimes(3);
  expect(await f.nodes()).toHaveLength(3);
  for (const node of await f.nodes()) expect(node.data).toMatchObject({ text: exact });
  expect(Buffer.byteLength(exact)).toBe(512);
});

it("finishes a catch-up across more than 32 model calls while preserving every original", async () => {
  const f = await fixture();
  for (let i = 0; i < 40; i += 1) await f.append(`RAW_${i} `.repeat(100));
  const work = durableMemoryWork(signal());
  const view = await f.memory.synchronize(work.signal, undefined, undefined, { work });
  expect(view.sourceCount).toBe(40);
  expect(work.metrics().calls).toBeGreaterThan(32);
  expect((await f.memory.zoom(0, 1, signal())).text).toContain("RAW_0");
  expect((await f.memory.zoom(39, 1, signal())).text).toContain("RAW_39");
});

it("allows a completion to run past the former work and call deadlines", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), milliseconds);
    return controller.signal;
  });
  try {
    const work = durableMemoryWork(signal());
    const pending = work.complete(
      () => new Promise((resolve) => setTimeout(() => resolve("complete summary"), 180_000)),
    );
    const result = expect(pending).resolves.toBe("complete summary");
    await vi.advanceTimersByTimeAsync(180_000);
    await result;
    expect(work.metrics()).toMatchObject({ calls: 1, elapsedMs: 180_000 });
  } finally {
    vi.useRealTimers();
  }
});

it("releases a non-cooperative completion when its lifecycle owner cancels", async () => {
  const cancellation = new AbortController();
  const work = durableMemoryWork(cancellation.signal);
  const started = Promise.withResolvers<AbortSignal>();
  const pending = work.complete((signal) => {
    started.resolve(signal);
    return new Promise<string>(() => undefined);
  });
  const callSignal = await started.promise;
  const reason = new Error("Stop");
  const failure = expect(pending).rejects.toBe(reason);
  cancellation.abort(reason);
  await failure;
  expect(callSignal.aborted).toBe(true);
});

it("cancels before publication and can resume with no abandoned leaf/carry nodes", async () => {
  const f = await fixture();
  await f.append("RAW_A ".repeat(100));
  const started = Promise.withResolvers<AbortSignal>();
  const pending = Promise.withResolvers<string>();
  f.summarize.mockImplementationOnce(({ signal }) => {
    started.resolve(signal);
    return pending.promise;
  });
  const cancellation = new AbortController();
  const view = f.memory.synchronize(cancellation.signal);
  const active = await started.promise;
  const failure = expect(view).rejects.toBeDefined();
  cancellation.abort();
  await failure;
  expect(active.aborted).toBe(true);
  expect(await f.nodes()).toHaveLength(0);
  pending.resolve("late answer");
  expect((await f.view()).sourceCount).toBe(1);
  expect((await f.view()).text).not.toContain("late answer");
});
