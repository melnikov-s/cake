import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  createRegistry,
  Harness,
  MemoryStorage,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
} from "@earendil-works/pi-durable";
import { Context, Effect, Exit, Layer, Schema, Scope } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OptMemoryId, type OptMemoryRange } from "../../../../src/contracts/memory/opt-memory-data";
import { OptMemory } from "../../../../src/services/opt-memory/OptMemory";
import { makeOptMemoryLive } from "../../../../src/services/opt-memory/OptMemoryLive";
import * as treeModule from "../../../../src/services/opt-memory/memory-tree";
import { type MemoryTreeOptions } from "../../../../src/services/opt-memory/memory-tree";
import { createDurableChatMemory } from "../../../../src/services/pi-durable/durable-chat-memory";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
const memoryId = () => OptMemoryId.make(crypto.randomUUID());
const signal = () => new AbortController().signal;
const payload = (context: string) =>
  context.slice(context.indexOf("<input>\n") + 8, context.lastIndexOf("\n</input>"));
const summary = () =>
  vi.fn<MemoryTreeOptions["summarize"]>(async () => `summary: ${"s".repeat(290)}`);
async function directory() {
  const location = await mkdtemp(join(tmpdir(), "cake-opt-memory-"));
  cleanup.push(() => rm(location, { recursive: true, force: true }));
  return location;
}
async function fixture(summarize = summary(), location?: string) {
  location ??= await directory();
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(
    Layer.buildWithScope(makeOptMemoryLive(location, { summarize }), scope),
  );
  const memory = Context.get(context, OptMemory);
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  cleanup.push(close);
  return {
    location,
    summarize,
    memory,
    close,
    read: (id: OptMemoryId, abort?: AbortSignal) =>
      Effect.runPromise(memory.read({ memoryId: id }), { signal: abort }),
    write: (id: OptMemoryId, text: string, sourceSessionId = "automation-session-1") =>
      Effect.runPromise(memory.write({ memoryId: id, text, sourceSessionId })),
    zoom: (
      id: OptMemoryId,
      range: OptMemoryRange,
      page: { offset?: number; maxChars?: number } = {},
    ) => Effect.runPromise(memory.zoom({ memoryId: id, range, ...page })),
    inspect: (query: string) => {
      const database = new DatabaseSync(join(location, "automation-memory.sqlite"), {
        readOnly: true,
      });
      try {
        return database.prepare(query).all();
      } finally {
        database.close();
      }
    },
  };
}
async function durableFixture(summarize = summary(), budget = 10_000) {
  const storage = new MemoryStorage();
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
  return {
    root,
    summarize,
    memory: createDurableChatMemory(harness, root, storage, { budget: () => budget, summarize }),
    append: (text: string) =>
      root.commit(
        (tx) =>
          tx.appendEntry(UserEntry, root.id, {
            model: [{ role: "user", content: text, timestamp: 1 }],
          }),
        BACKGROUND_CONTEXT,
      ),
    head: (text: string) =>
      root.commit(
        (tx) =>
          tx.appendEntry(ResetEntry, root.id, {
            head: "self",
            model: [{ role: "user", content: text, timestamp: 1 }],
          }),
        BACKGROUND_CONTEXT,
      ),
  };
}

describe("shared OptMem core and automation adapter", () => {
  it("uses the extracted compaction core for Durable chat and automation memory", async () => {
    const core = vi.spyOn(treeModule, "createMemoryTree");
    const durable = await durableFixture();
    const automation = await fixture();
    const id = memoryId();
    for (const marker of ["A", "B", "C", "D"]) {
      await durable.append(`RAW_${marker} `.repeat(100));
      await automation.write(id, `RAW_${marker} `.repeat(100));
    }
    expect((await durable.memory.synchronize(signal())).sourceCount).toBe(4);
    expect((await automation.read(id)).sourceCount).toBe(4);
    expect(core).toHaveBeenCalledTimes(2);
    expect(durable.summarize).toHaveBeenCalledTimes(7);
    expect(automation.summarize).toHaveBeenCalledTimes(7);
    expect((await durable.memory.zoom(0, 4, signal())).text).toMatch(/0\+2\|.*\n2\+2\|/);
    expect(await automation.zoom(id, { id: 0, n: 4 })).toMatchObject({
      _tag: "Branch",
      children: [{ range: { id: 0, n: 2 } }, { range: { id: 2, n: 2 } }],
    });
  });

  it("exposes a 10000-byte automation view without limiting total retained originals", async () => {
    const f = await fixture();
    const id = memoryId();
    let originalBytes = 0;
    for (let i = 0; i < 64; i += 1) {
      const original = `NOTE_${i} ${"界".repeat(400)}`;
      originalBytes += Buffer.byteLength(original);
      await f.write(id, original);
    }
    const view = await f.read(id);
    expect(view).toMatchObject({ budgetBytes: 10_000, sourceCount: 64 });
    expect(view.bytes).toBeLessThanOrEqual(10_000);
    expect(view.bytes).toBe(
      Buffer.byteLength(
        `<chat>\n${view.lines.map((line) => `${line.range.id}+${line.range.n}|${line.text}`).join("\n")}\n</chat>`,
      ),
    );
    expect(originalBytes).toBeGreaterThan(view.budgetBytes * 7);
    expect(view.lines.some((line) => line.range.n >= 4)).toBe(true);
    for (let i = 0; i < 64; i += 1)
      expect(await f.zoom(id, { id: i, n: 1 })).toMatchObject({
        _tag: "Original",
        text: `NOTE_${i} ${"界".repeat(400)}`,
      });
  });

  it("compacts adjacent summaries into deeper branches and zooms repeatedly to exact originals", async () => {
    const f = await fixture();
    const id = memoryId();
    const notes = Array.from({ length: 64 }, (_, i) => `RAW_${i} ${"detail ".repeat(100)}`);
    for (const note of notes) await f.write(id, note);
    const view = await f.read(id);
    expect(view.lines.some((line) => line.range.n >= 4)).toBe(true);
    const recalled: string[] = [];
    const visit = async (range: OptMemoryRange): Promise<void> => {
      const zoom = await f.zoom(id, range);
      if (zoom._tag === "Original") recalled.push(zoom.text);
      else {
        expect(zoom.children.map((line) => line.range)).toEqual([
          { id: range.id, n: range.n / 2 },
          { id: range.id + range.n / 2, n: range.n / 2 },
        ]);
        for (const child of zoom.children) await visit(child.range);
      }
    };
    for (const line of view.lines) await visit(line.range);
    expect(recalled).toEqual(notes);
    await expect(f.zoom(id, { id: 1, n: 2 })).rejects.toThrow("divisible by n");
    await expect(f.zoom(id, { id: 0, n: 3 })).rejects.toThrow("power of two");
    await expect(f.zoom(id, { id: 0, n: 2 }, { offset: 0 })).rejects.toThrow("expand to n=1 first");
  });

  it("preserves UTF-8 budgets and the existing summarizer retry and excerpt behavior", async () => {
    const summarize = summary();
    const shortest = "界".repeat(171);
    for (const answer of [
      "a".repeat(700),
      "b".repeat(600),
      shortest,
      "c".repeat(650),
      "d".repeat(800),
    ])
      summarize.mockResolvedValueOnce(answer);
    const f = await fixture(summarize);
    const id = memoryId();
    const original = `HEAD ${"界".repeat(30_000)} TAIL`;
    const first = await f.write(id, original);
    expect((await f.read(id)).lines[0]?.text).toBe(shortest);
    expect(summarize.mock.calls.map(([input]) => input.previous?.length)).toEqual([0, 2, 4, 6, 8]);
    expect(summarize.mock.calls[3]?.[0].previous?.at(-1)?.text).toContain("513 bytes");
    const input = payload(summarize.mock.calls[0]![0].context);
    expect(Buffer.byteLength(input)).toBeLessThan(64_100);
    expect(input).toContain("HEAD");
    expect(input).toContain("TAIL");
    expect(input).toContain("bytes omitted; zoom for the original");
    summarize.mockRejectedValueOnce(new Error("provider failed")).mockResolvedValueOnce("");
    await f.write(id, "SECOND ".repeat(100));
    const view = await f.read(id);
    const excerpt = view.lines.find((line) => line.range.id === 1)?.text;
    expect(excerpt).toContain("[excerpt; summary unavailable] note:");
    expect(Buffer.byteLength(excerpt ?? "")).toBeLessThanOrEqual(512);
    expect(summarize).toHaveBeenCalledTimes(8); // five shortenings, two failures, one merge
    const pages: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const zoom = await f.zoom(id, { id: 0, n: 1 }, { offset });
      if (zoom._tag !== "Original") throw new Error("Expected original");
      expect(zoom.sourceId).toBe(first.sourceId);
      expect(zoom.totalChars).toBe(original.length);
      pages.push(zoom.text);
      offset = zoom.nextOffset;
    }
    expect(pages.join("")).toBe(original);
  });

  it("preserves Durable chat source filtering, source bounds, stale handles and original recall", async () => {
    const f = await durableFixture(summary(), 600);
    const a = await f.append("RAW_A ".repeat(100));
    await f.root.commit(async (tx) => {
      await tx.appendEntry(AssistantEntry, f.root.id, {
        model: [durableAnswer("", [{ type: "thinking", thinking: "PRIVATE_REASONING" }])],
      });
      await tx.appendEntry(ToolResultEntry, f.root.id, {
        data: { diagnostics: [] },
        model: [
          {
            role: "toolResult",
            toolCallId: "test",
            toolName: "inspect",
            content: [{ type: "text", text: "PRIVATE_TOOL_OUTPUT" }],
            isError: false,
            timestamp: 1,
          },
        ],
      });
    }, BACKGROUND_CONTEXT);
    const b = await f.append("RAW_B ".repeat(100));
    await f.head("<chat>\n0+1|old handle\n</chat>");
    const before = await f.root.context(BACKGROUND_CONTEXT);
    const view = await f.memory.synchronize(signal());
    expect(view).toMatchObject({ sourceCount: 2, partCount: 1 });
    expect(view.text).toContain(`[originals=${a.id}..${b.id}]`);
    expect(f.summarize.mock.calls.map(([input]) => input.context).join("\n")).not.toMatch(
      /PRIVATE_REASONING|PRIVATE_TOOL_OUTPUT/,
    );
    expect((await f.root.context(BACKGROUND_CONTEXT)).messages).toEqual(before.messages);
    await expect(f.memory.zoom(0, 1, signal())).rejects.toThrow("handle is stale");
    await f.head(view.text);
    const recalled = await f.memory.zoom(0, 1, signal());
    expect(recalled.text).toContain("RAW_A ".repeat(100));
    expect(recalled.messages).toEqual(a.model);
  });

  it("keeps the existing Durable chat memory and scheduling regression suites passing", async () => {
    const f = await durableFixture();
    await f.append("RAW_A ".repeat(100));
    await f.append("RAW_B ".repeat(100));
    expect(
      await f.memory.synchronize(signal(), undefined, undefined, { readyOnly: true }),
    ).toMatchObject({ complete: false, sourceCount: 0 });
    expect(f.summarize).not.toHaveBeenCalled();
    expect(
      await f.memory.synchronize(signal(), undefined, undefined, { maxOriginals: 1 }),
    ).toMatchObject({ complete: false, sourceCount: 1 });
    expect(f.summarize).toHaveBeenCalledTimes(1);
    expect(await f.memory.synchronize(signal())).toMatchObject({ complete: true, sourceCount: 2 });
    expect(f.summarize).toHaveBeenCalledTimes(3);
    expect(
      await f.memory.synchronize(signal(), undefined, undefined, { readyOnly: true }),
    ).toMatchObject({ complete: true, sourceCount: 2 });
    expect(f.summarize).toHaveBeenCalledTimes(3);
  });

  it("writes an intentional note with trusted automation-session provenance", async () => {
    const f = await fixture();
    const id = memoryId();
    const result = await f.write(
      id,
      "Remember the approved release decision.",
      "trusted-run-session",
    );
    const rows = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ data: Schema.String })))(
      f.inspect("SELECT data FROM memory_notes"),
    );
    expect(rows.map((row) => JSON.parse(row.data))).toEqual([
      {
        sourceId: result.sourceId,
        text: "Remember the approved release decision.",
        sourceSessionId: "trusted-run-session",
      },
    ]);
    expect((await f.read(id)).lines[0]?.text).toContain("note: [session=trusted-run-session]");
    expect(await f.zoom(id, { id: 0, n: 1 })).toMatchObject({
      _tag: "Original",
      sourceId: result.sourceId,
      text: "Remember the approved release decision.",
    });
  });

  it("shares notes across fresh sessions of one automation without copying prior transcripts", async () => {
    const location = await directory();
    const first = await fixture(summary(), location);
    const id = memoryId();
    await first.write(id, "First run's intentional note", "run-1");
    await first.close();
    const next = await fixture(summary(), location);
    expect((await next.read(id)).sourceCount).toBe(1);
    await next.write(id, "Second run's intentional note", "run-2");
    expect((await next.read(id)).sourceCount).toBe(2);
    expect(await next.zoom(id, { id: 0, n: 1 })).toMatchObject({
      _tag: "Original",
      text: "First run's intentional note",
    });
    expect(await next.zoom(id, { id: 1, n: 1 })).toMatchObject({
      _tag: "Original",
      text: "Second run's intentional note",
    });
    expect(next.inspect("SELECT id FROM memory_notes")).toHaveLength(2);
  });

  it("keeps different automations' memories separate even when both use the same project", async () => {
    const f = await fixture();
    const a = memoryId(),
      b = memoryId();
    await f.write(a, "Automation A in shared project", "shared-project-session");
    await f.write(b, "Automation B in shared project", "shared-project-session");
    expect((await f.read(a)).lines.map((line) => line.text).join(" ")).toContain("Automation A");
    expect((await f.read(b)).lines.map((line) => line.text).join(" ")).toContain("Automation B");
    expect(await f.zoom(a, { id: 0, n: 1 })).toMatchObject({
      _tag: "Original",
      text: "Automation A in shared project",
    });
    expect(await f.zoom(b, { id: 0, n: 1 })).toMatchObject({
      _tag: "Original",
      text: "Automation B in shared project",
    });
    expect((await f.read(memoryId())).sourceCount).toBe(0);
  });

  it("retains notes from parallel sessions through serialized persistence", async () => {
    const summarize = summary();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    summarize.mockImplementationOnce(() => {
      started.resolve();
      return release.promise;
    });
    const f = await fixture(summarize);
    const id = memoryId();
    await f.write(id, "LONG_NOTE ".repeat(100));
    const reading = f.read(id);
    await started.promise;
    let written = false;
    const writing = f.write(id, "queued during compaction", "parallel-session").then(() => {
      written = true;
    });
    await f.write(memoryId(), "Another automation does not wait for this provider.");
    expect(written).toBe(false);
    release.resolve("compacted note");
    await Promise.all([reading, writing]);
    const concurrent = Array.from({ length: 32 }, (_, i) => ({
      memoryId: id,
      text: `note-${i}`,
      sourceSessionId: `parallel-${i}`,
    }));
    const results = await Effect.runPromise(
      Effect.all(
        concurrent.map((input) => f.memory.write(input)),
        { concurrency: "unbounded" },
      ),
    );
    expect(new Set(results.map((result) => result.sourceId)).size).toBe(32);
    expect((await f.read(id)).sourceCount).toBe(34);
    const originals = [];
    for (let i = 0; i < 34; i += 1) originals.push(await f.zoom(id, { id: i, n: 1 }));
    expect(
      originals
        .slice(2)
        .map((original) => (original._tag === "Original" ? original.text : "branch"))
        .sort(),
    ).toEqual(concurrent.map((input) => input.text).sort());
  });

  it("keeps one session's Zoom navigation from changing another session's injected view", async () => {
    const f = await fixture();
    const id = memoryId();
    for (let i = 0; i < 64; i += 1) await f.write(id, `NOTE_${i} ${"detail ".repeat(100)}`);
    const before = await f.read(id);
    const compressed = before.lines.find((line) => line.range.n >= 4);
    if (!compressed) throw new Error("Expected compacted branch");
    const branch = await f.zoom(id, compressed.range);
    if (branch._tag !== "Branch") throw new Error("Expected branch");
    await f.zoom(id, branch.children[0]!.range);
    await f.zoom(id, { id: compressed.range.id, n: 1 });
    expect(await f.read(id)).toEqual(before);
  });

  it("resumes persisted compaction work after restart without losing original notes", async () => {
    const location = await directory();
    const cancellation = new AbortController();
    const summarize = summary();
    summarize.mockImplementation(async ({ context }) => {
      if (context.includes("merge lines 0+2 and 2+2")) {
        cancellation.abort(new Error("interrupted final carry"));
        return new Promise<string>(() => undefined);
      }
      return `committed child: ${"s".repeat(290)}`;
    });
    const first = await fixture(summarize, location);
    const id = memoryId();
    const notes = ["A", "B", "C", "D"].map((marker) => `RAW_${marker} `.repeat(100));
    for (const note of notes) await first.write(id, note);
    await expect(first.read(id, cancellation.signal)).rejects.toThrow();
    expect(first.inspect("SELECT id FROM memory_notes")).toHaveLength(4);
    expect(first.inspect("SELECT id FROM memory_nodes")).toHaveLength(6);
    await first.close();
    const reopened = await fixture(summary(), location);
    expect((await reopened.read(id)).sourceCount).toBe(4);
    expect(reopened.summarize).toHaveBeenCalledTimes(1);
    expect(payload(reopened.summarize.mock.calls[0]![0].context)).not.toContain("RAW_");
    expect(reopened.inspect("SELECT id FROM memory_nodes")).toHaveLength(7);
    for (let i = 0; i < notes.length; i += 1)
      expect(await reopened.zoom(id, { id: i, n: 1 })).toMatchObject({
        _tag: "Original",
        text: notes[i],
      });
    await reopened.read(id);
    expect(reopened.summarize).toHaveBeenCalledTimes(1);
  });
});
