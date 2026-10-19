import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  UserEntry,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDurableChatMemory,
  type DurableMemoryOptions,
} from "../../../../src/services/pi-durable/durable-chat-memory";
import {
  durableMemoryWork,
  MEMORY_CALL_MS,
  MEMORY_FOREGROUND_WORK,
} from "../../../../src/services/pi-durable/durable-memory-work";
import { durableModels } from "../../../fixtures/durable-chat";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const signal = () => new AbortController().signal;
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
  first.summarize
    .mockResolvedValueOnce("summary-D: " + "d".repeat(290))
    .mockResolvedValueOnce("merged-CD: " + "m".repeat(290))
    .mockRejectedValueOnce(new Error("fixture failure at final carry"));
  await expect(first.view()).rejects.toMatchObject({ reason: "completion-failed" });
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

it("rejects empty output without truncation or a placeholder and retries at the next explicit opportunity", async () => {
  const f = await fixture();
  await f.append("RAW_B ".repeat(100));
  f.summarize.mockResolvedValue("");
  await expect(f.view()).rejects.toMatchObject({ reason: "empty-summary" });
  expect(f.summarize).toHaveBeenCalledOnce();
  expect(await f.nodes()).toHaveLength(0);
  f.summarize.mockResolvedValue("valid summary");
  expect((await f.view()).sourceCount).toBe(1);
  expect((await f.memory.zoom(0, 1, signal())).text).toContain("RAW_B ".repeat(100));
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

it("bounds application calls across an entire catch-up and preserves committed originals for explicit continuation", async () => {
  const f = await fixture();
  await f.append("RAW_A ".repeat(100));
  await f.append("RAW_B ".repeat(100));
  const work = durableMemoryWork(signal(), { milliseconds: 60_000, calls: 2 });
  await expect(
    f.memory.synchronize(work.signal, undefined, undefined, { work }),
  ).rejects.toMatchObject({ reason: "work-allowance" });
  expect(f.summarize).toHaveBeenCalledTimes(2); // Both independent leaves committed; their parent resumes later.
  expect(await f.nodes()).toHaveLength(2);
  expect(work.metrics().calls).toBe(2);
  expect((await f.view()).sourceCount).toBe(2);
  expect(
    f.summarize.mock.calls
      .map(([input]) => inputText(input.context))
      .filter((input) => input.includes("RAW_A")),
  ).toHaveLength(1);
});

it.each(["call", "overall"] as const)(
  "applies the %s deadline to model resolution/completion and releases a non-cooperative callback",
  async (deadline) => {
    const deadlines: AbortController[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const controller = new AbortController();
      deadlines.push(controller);
      return controller.signal;
    });
    const work = durableMemoryWork(signal());
    const started = Promise.withResolvers<AbortSignal>();
    const pending = work.complete((signal) => {
      started.resolve(signal);
      return new Promise<string>(() => undefined);
    });
    const callSignal = await started.promise;
    expect(timeout.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([
      MEMORY_FOREGROUND_WORK.milliseconds,
      MEMORY_CALL_MS,
    ]);
    const failure = expect(pending).rejects.toMatchObject({
      reason: deadline === "call" ? "completion-allowance" : "work-allowance",
    });
    deadlines[deadline === "overall" ? 0 : 1]?.abort();
    await failure;
    expect(callSignal.aborted).toBe(true);
    expect(work.metrics().calls).toBe(1);
  },
);

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
