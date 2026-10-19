import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineDoc,
  defineEntry,
  Harness,
  MemoryStorage,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  createDurableChatMemory,
  type DurableMemoryOptions,
} from "../../../../src/services/pi-durable/durable-chat-memory";
import { durableModels } from "../../../fixtures/durable-chat";
import { defaultCakeChatPreferences } from "../../../../src/contracts/cake-chats/cake-chat-preferences";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
const input = (context: string) => context.split("<input>\n")[1]?.split("\n</input>")[0] ?? "";
const identify = (context: string) => {
  const leaf = /compress message (\d+)/.exec(context);
  const parent = /merge lines (\d+)\+(\d+)/.exec(context);
  return leaf
    ? { id: Number(leaf[1]), n: 1 }
    : { id: Number(parent![1]), n: 2 * Number(parent![2]) };
};
async function fixture(
  summarize: DurableMemoryOptions["summarize"],
  storage: Storage = new MemoryStorage(),
  budget = defaultCakeChatPreferences().memoryViewBytes,
) {
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
  const memory = createDurableChatMemory(harness, root, storage, {
    summarize,
    budget: () => budget,
  });
  return {
    harness,
    root,
    memory,
    append: (text: string) =>
      root.commit(
        (tx) =>
          tx.appendEntry(UserEntry, root.id, {
            model: [{ role: "user", content: text, timestamp: 1 }],
          }),
        BACKGROUND_CONTEXT,
      ),
    async nodes() {
      const nodes = [];
      let cursor;
      do {
        const page = await root.entries({ order: "ascending" }, 64, cursor, BACKGROUND_CONTEXT);
        nodes.push(...page.items.filter((entry) => entry.kind === "cake.chat-memory-node/v1"));
        cursor = page.next;
      } while (cursor !== undefined);
      return nodes;
    },
  };
}

it("runs eight independent requests, admits a later leaf with seven preceding unbuilt lines, and starts parents only after both children commit", async () => {
  type Request = { id: number; n: number; context: string; finish(): void };
  const queued: Request[] = [];
  const waiters: Array<(request: Request) => void> = [];
  const held: Request[] = [];
  let automatic = false;
  let active = 0;
  let peak = 0;
  const next = () =>
    queued.length
      ? Promise.resolve(queued.shift()!)
      : new Promise<Request>((resolve) => waiters.push(resolve));
  const f = await fixture(async ({ context }) => {
    const { id, n } = identify(context);
    const result = Promise.withResolvers<string>();
    active += 1;
    peak = Math.max(peak, active);
    const request = {
      id,
      n,
      context,
      finish: () => result.resolve(`node-${id}+${n}: ${"s".repeat(300)}`),
    };
    held.push(request);
    if (automatic) request.finish();
    else {
      const waiter = waiters.shift();
      if (waiter) waiter(request);
      else queued.push(request);
    }
    try {
      return await result.promise;
    } finally {
      active -= 1;
    }
  });
  for (let i = 0; i < 10; i += 1) await f.append(`RAW_${i} `.repeat(100));
  const pending = f.memory.synchronize(signal());
  const first = [];
  for (let i = 0; i < 8; i += 1) first.push(await next());
  expect(first.map((r) => [r.id, r.n])).toEqual(Array.from({ length: 8 }, (_, i) => [i, 1]));
  expect(active).toBe(8);
  first[3]!.finish();
  const ninth = await next();
  expect(ninth).toMatchObject({ id: 8, n: 1 });
  expect(ninth.context.split("\n\nCompaction:")[0]).toBe("<chat>\n\n</chat>"); // Leaf 3 is built, but leaf 0 is not.
  first[1]!.finish();
  expect(await next()).toMatchObject({ id: 9, n: 1 });
  first[0]!.finish();
  const parent = await next();
  expect(parent).toMatchObject({ id: 0, n: 2 });
  expect(input(parent.context)).toContain("node-0+1");
  expect(input(parent.context)).toContain("node-1+1");
  expect(input(parent.context)).not.toContain("RAW_");
  const reference = parent.context.split("\n\nCompaction:")[0]!;
  expect(reference).toMatch(/0\+1\|\[originals=\d+\.\.\d+\] node-0\+1/);
  expect(reference).toMatch(/1\+1\|\[originals=\d+\.\.\d+\] node-1\+1/);
  expect(reference).not.toContain("3+1|"); // First unbuilt leaf is 2, despite out-of-order completions.
  automatic = true;
  for (const request of held) request.finish();
  const view = await pending;
  expect(view.sourceCount).toBe(10);
  expect(peak).toBe(8);
  const nodes = await f.nodes();
  expect(nodes).toHaveLength(18);
  expect(
    new Set(
      nodes.map((entry) => {
        const range = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Int, n: Schema.Int }))(
          entry.data,
        );
        return `${range.id}+${range.n}`;
      }),
    ).size,
  ).toBe(18);
  for (let i = 0; i < 10; i += 1)
    expect((await f.memory.zoom(i, 1, signal())).text).toContain(`RAW_${i} `.repeat(100));
});

it("persists out-of-order progress through cancellation and SQLite reopen without repeating a completed leaf", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-memory-parallel-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "memory.sqlite");
  const started = Promise.withResolvers<AbortSignal>();
  const stored = Promise.withResolvers<void>();
  const never = Promise.withResolvers<string>();
  const first = await fixture(
    async ({ context, signal }) => {
      if (identify(context).id === 0) {
        started.resolve(signal);
        return never.promise;
      }
      return `built-B: ${"b".repeat(300)}`;
    },
    await openNodeSqliteStorage(database),
  );
  await first.append("RAW_A ".repeat(100));
  await first.append("RAW_B ".repeat(100));
  const unsubscribe = first.harness.subscribeCommits((publication) => {
    if (
      publication.changes.some(
        (change) => change.type === "entry" && change.value.kind === "cake.chat-memory-node/v1",
      )
    )
      stored.resolve();
  });
  const stop = new AbortController();
  const pending = first.memory.synchronize(stop.signal);
  const providerSignal = await started.promise;
  await stored.promise;
  const failure = expect(pending).rejects.toBeDefined();
  stop.abort();
  await failure;
  expect(providerSignal.aborted).toBe(true);
  expect(await first.nodes()).toHaveLength(1);
  unsubscribe();
  await first.harness.close(BACKGROUND_CONTEXT);
  cleanup.pop();
  const summarize = vi.fn<DurableMemoryOptions["summarize"]>(
    async () => `resumed: ${"r".repeat(300)}`,
  );
  const reopened = await fixture(summarize, await openNodeSqliteStorage(database));
  expect((await reopened.memory.synchronize(signal())).sourceCount).toBe(2);
  expect(summarize).toHaveBeenCalledTimes(2); // A and AB, never B again.
  expect(summarize.mock.calls.map(([request]) => input(request.context)).join(" ")).not.toContain(
    "RAW_B",
  );
  expect(await reopened.nodes()).toHaveLength(3);
  never.resolve("late abandoned output");
  expect((await reopened.memory.synchronize(signal())).text).not.toContain("late abandoned output");
});

it("defers ready-only reads of a persisted serial merge chain without repeating completed work", async () => {
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<string>();
  const summarize = vi.fn<DurableMemoryOptions["summarize"]>(async ({ context }) => {
    const { id, n } = identify(context);
    if (n === 8) {
      started.resolve();
      return pending.promise;
    }
    return `built-${id}+${n}: ${"s".repeat(300)}`;
  });
  const f = await fixture(summarize);
  for (let i = 0; i < 8; i += 1) await f.append(`RAW_${i} `.repeat(100));
  const stop = new AbortController();
  const building = f.memory.synchronize(stop.signal);
  await started.promise;
  const failure = expect(building).rejects.toBeDefined();
  stop.abort();
  await failure;
  const calls = summarize.mock.calls.length;
  const nodes = await f.nodes();
  expect(nodes).toHaveLength(14); // All leaves and lower merges are already committed.
  expect(
    await f.memory.synchronize(signal(), undefined, undefined, { readyOnly: true }),
  ).toMatchObject({
    complete: false,
    sourceCount: 8,
  });
  expect(summarize).toHaveBeenCalledTimes(calls);
  expect(await f.nodes()).toEqual(nodes);
  pending.resolve("abandoned result");
  summarize.mockResolvedValue("talk: resumed final merge");
  expect((await f.memory.synchronize(signal())).complete).toBe(true);
  expect(summarize).toHaveBeenCalledTimes(calls + 1);
  expect(await f.nodes()).toHaveLength(15);
  const ready = await f.memory.synchronize(signal(), undefined, undefined, { readyOnly: true });
  expect(ready).toMatchObject({ complete: true, sourceCount: 8 });
  expect(ready.text).not.toContain("abandoned result");
  expect(summarize).toHaveBeenCalledTimes(calls + 1);
});

it.each(["complete", "pending"] as const)(
  "fits an existing oversized SQLite index to 40k/20k after reopen with %s parents, preserving nodes and zoom",
  async (parents) => {
    const directory = await mkdtemp(join(tmpdir(), "cake-memory-budget-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "memory.sqlite");
    const first = await fixture(
      async ({ context }) => {
        const { id, n } = identify(context);
        if (parents === "pending" && n === 128) throw new Error("Parent temporarily unavailable");
        return `built-${id}+${n}: ${"s".repeat(480)}`;
      },
      await openNodeSqliteStorage(database),
      128_000,
    );
    for (let i = 0; i < 128; i += 1) await first.append(`RAW_${i} `.repeat(100));
    if (parents === "pending") {
      await expect(first.memory.synchronize(signal())).rejects.toBeDefined();
    } else {
      const large = await first.memory.synchronize(signal());
      expect(large.bytes).toBeGreaterThan(40_000);
      expect(large.bytes).toBeLessThan(128_000);
      expect(large.partCount).toBe(128);
    }
    const stored = await first.nodes();
    expect(stored).toHaveLength(parents === "pending" ? 254 : 255);
    const head = (await first.root.context(BACKGROUND_CONTEXT)).head?.id;
    await first.harness.close(BACKGROUND_CONTEXT);
    cleanup.pop();

    const summarize = vi.fn<DurableMemoryOptions["summarize"]>(
      async () => `resumed parent: ${"r".repeat(480)}`,
    );
    const reopened = await fixture(summarize, await openNodeSqliteStorage(database));
    const ready = await reopened.memory.synchronize(signal(), undefined, undefined, {
      readyOnly: true,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(await reopened.nodes()).toEqual(stored);
    expect(ready.complete).toBe(parents === "complete");
    expect(ready.sourceCount).toBe(128);
    const small = parents === "pending" ? await reopened.memory.synchronize(signal()) : ready;
    expect(small).toMatchObject({ complete: true, sourceCount: 128 });
    expect(small.bytes).toBeLessThanOrEqual(20_000);
    expect(small.bytes).toBeGreaterThan(0);
    expect(small.partCount).toBeLessThan(128);
    expect(summarize).toHaveBeenCalledTimes(parents === "pending" ? 1 : 0);
    if (parents === "pending")
      expect(identify(summarize.mock.calls[0]![0].context)).toEqual({ id: 0, n: 128 });
    const after = await reopened.nodes();
    expect(after.slice(0, stored.length)).toEqual(stored);
    expect(after).toHaveLength(255);
    expect((await reopened.root.context(BACKGROUND_CONTEXT)).head?.id).toBe(head);
    expect((await reopened.memory.zoom(0, 128, signal())).text).toContain("built-0+64");
    for (const id of [0, 63, 127])
      expect((await reopened.memory.zoom(id, 1, signal())).text).toContain(
        `RAW_${id} `.repeat(100),
      );
    expect(await reopened.memory.synchronize(signal())).toEqual(small);
    expect(summarize).toHaveBeenCalledTimes(parents === "pending" ? 1 : 0);
  },
);

it.each([4_000, 40_000])(
  "maintains separate 16/32 KB compaction references and binary view/zoom invariants across source windows (budget %i)",
  async (budget) => {
    const summarize = vi.fn<DurableMemoryOptions["summarize"]>(async ({ context }) => {
      const { id, n } = identify(context);
      return `built-${id}+${n}: ${"s".repeat(480)}`;
    });
    const f = await fixture(summarize, new MemoryStorage(), budget);
    const originals = [];
    for (let i = 0; i < 96; i += 1) originals.push(await f.append(`RAW_${i} `.repeat(100)));
    const view = await f.memory.synchronize(signal());
    expect(view.sourceCount).toBe(96);
    expect(view.bytes).toBeLessThanOrEqual(budget);
    expect(view.partCount).toBeLessThan(96);
    let through = 0;
    for (const match of view.text.matchAll(/^(\d+)\+(\d+)\|\[originals=(\d+)\.\.(\d+)\]/gm)) {
      const id = Number(match[1]);
      const n = Number(match[2]);
      expect(id).toBe(through);
      expect(id % n).toBe(0);
      expect(Number.isInteger(Math.log2(n))).toBe(true);
      expect(Number(match[3])).toBe(originals[id]!.id);
      expect(Number(match[4])).toBe(originals[id + n - 1]!.id);
      through += n;
      if (n > 1) {
        const zoomed = await f.memory.zoom(id, n, signal());
        expect(zoomed.text.split("\n").map((line) => line.split("|")[0])).toEqual([
          `${id}+${n / 2}`,
          `${id + n / 2}+${n / 2}`,
        ]);
      }
    }
    expect(through).toBe(96);
    const references = summarize.mock.calls.map(
      ([request]) => request.context.split("\n\nCompaction:")[0]!,
    );
    expect(Math.max(...references.map((text) => Buffer.byteLength(text)))).toBeLessThanOrEqual(
      32_000,
    );
    const count = summarize.mock.calls.length;
    expect((await f.memory.synchronize(signal())).text).toBe(view.text);
    expect(summarize).toHaveBeenCalledTimes(count); // No raw-history reprocessing or reference refit on no-op reopen/read.
  },
);

it.each([1, 2])(
  "rebuilds a version-%i derived index from dialogue originals, discarding old summaries and pending jobs",
  async (version) => {
    const NodeEntry = defineEntry<{ id: number; n: number; text: string; original: number }>(
      "cake.chat-memory-node/v1",
    );
    const Legacy = defineDoc<{
      through: number;
      count: number;
      budget: number;
      shrinking: boolean;
      forest: { id: number; n: number; entry: number }[];
      parts: { id: number; n: number; entry: number; ancestors: number[] }[];
    }>({
      kind: "cake.chat-memory-state",
      version,
      scope: "conversation",
      history: "latest",
      fork: "initial",
      initial: () => ({
        through: 0,
        count: 0,
        budget: 4_000,
        shrinking: false,
        forest: [],
        parts: [],
      }),
    });
    const directory = await mkdtemp(join(tmpdir(), "cake-memory-v1-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "memory.sqlite");
    const first = await fixture(async () => "unused", await openNodeSqliteStorage(database), 4_000);
    const original = await first.append("Persisted original");
    const tool = await first.root.commit(
      (tx) =>
        tx.appendEntry(ToolResultEntry, first.root.id, {
          data: { diagnostics: [] },
          model: [
            {
              role: "toolResult",
              toolCallId: "old-call",
              toolName: "inspect",
              content: [{ type: "text", text: "OLD_TOOL_OUTPUT ".repeat(200) }],
              isError: false,
              timestamp: 1,
            },
          ],
        }),
      BACKGROUND_CONTEXT,
    );
    await first.root.commit(async (tx) => {
      const stored = await tx.appendEntry(NodeEntry, first.root.id, {
        data: {
          id: 0,
          n: 1,
          text: "old summary contaminated with tool output",
          original: original.id,
        },
      });
      Object.assign(await tx.doc(Legacy, first.root.id), {
        through: original.id,
        count: 1,
        budget: 4_000,
        shrinking: false,
        forest: [{ id: 0, n: 1, entry: stored.id }],
        parts: [{ id: 0, n: 1, entry: stored.id, ancestors: [] }],
        ...(version === 2
          ? {
              pending: {
                jobs: [{ id: 1, n: 1, original: tool.id }],
                forest: [{ id: 1, n: 1, link: { job: 0 } }],
              },
            }
          : {}),
      });
    }, BACKGROUND_CONTEXT);
    await first.root.commit(
      (tx) =>
        tx.appendEntry(ResetEntry, first.root.id, {
          head: "self",
          model: [
            {
              role: "user",
              content: "<chat>\n0+1|old summary contaminated with tool output\n</chat>",
              timestamp: 1,
            },
          ],
        }),
      BACKGROUND_CONTEXT,
    );
    const active = await first.root.context(BACKGROUND_CONTEXT);
    await first.harness.close(BACKGROUND_CONTEXT);
    cleanup.pop();
    const summarize = vi.fn(async () => "must not run");
    const reopened = await fixture(summarize, await openNodeSqliteStorage(database), 4_000);
    expect(
      await reopened.memory.synchronize(signal(), undefined, undefined, { readyOnly: true }),
    ).toMatchObject({ complete: false, sourceCount: 0 });
    expect(summarize).not.toHaveBeenCalled();
    expect(await reopened.nodes()).toHaveLength(1); // No migrated work on a cache-only read.
    expect((await reopened.root.context(BACKGROUND_CONTEXT)).messages).toEqual(active.messages);
    expect((await reopened.memory.synchronize(signal())).text).toBe(
      `<chat>\n0+1|[originals=${original.id}..${original.id}] user: Persisted original\n</chat>`,
    );
    expect(summarize).not.toHaveBeenCalled();
    expect((await reopened.root.context(BACKGROUND_CONTEXT)).messages).toEqual(active.messages);
    await expect(reopened.memory.zoom(0, 1, signal())).rejects.toThrow("Read original history");
    await expect(reopened.memory.inspect(0, 1, signal())).rejects.toThrow("Read original history");
    const view = await reopened.memory.synchronize(signal());
    await reopened.root.commit(
      (tx) =>
        tx.appendEntry(ResetEntry, reopened.root.id, {
          head: "self",
          model: [{ role: "user", content: view.text, timestamp: 1 }],
        }),
      BACKGROUND_CONTEXT,
    );
    expect((await reopened.memory.zoom(0, 1, signal())).text).toContain("Persisted original");
    expect(await reopened.nodes()).toHaveLength(2); // Immutable old entry remains, but is no longer indexed.
    await reopened.memory.synchronize(signal());
    expect(await reopened.nodes()).toHaveLength(2); // The migrated checkpoint persists; no repeated rebuild.
  },
);
