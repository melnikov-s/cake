import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createRegistry,
  defineExtension,
  defineTool,
  MemoryStorage,
  InboxDoc,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-durable-ai";
import { afterEach, expect, it, vi } from "vitest";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { abortDurableActiveTurn } from "../../../../src/services/pi-durable/durable-chat-queue";
import {
  durableInputText,
  durableInputPresentation,
  markDurableInputSteering,
} from "../../../../src/services/pi-durable/durable-input-presentation";
import {
  investigatorOrigin,
  researchOrigin,
  researchMarkdown,
} from "../../../fixtures/subagent-report";
import { subagentCompletionMessage } from "../../../../src/services/pi/runtime/cake-session-runtime";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(answer?: Parameters<typeof durableModels>[0], keepRecentTokens = 20_000) {
  const f = durableModels(answer);
  const summarize = vi.fn(async () => "talk: exact details remain available through zoom");
  let budget = 4_000;
  const registry = createRegistry();
  const zoom = defineTool({
    name: "zoom",
    description: "Retrieve original detail",
    parameters: Type.Object({ id: Type.Integer(), n: Type.Integer() }),
    replay: "safe",
    async execute(input, _api, context) {
      const found = await engine.memory.zoom(
        input.id,
        input.n,
        context.abortSignal ?? new AbortController().signal,
      );
      return { content: [{ type: "text", text: found.text }] };
    },
  });
  registry.install(defineExtension({ name: "memory", tools: [zoom] }));
  const engine = await openDurableChatEngine({
    storage: new MemoryStorage(),
    models: f.models,
    registry,
    agent: {
      model: { provider: "fixture", modelId: "fixture" },
      instructions: "<cake-chat-instructions>Always use worktrees</cake-chat-instructions>",
      tools: [zoom],
    },
    memory: { budget: () => budget, summarize },
    settings: { contextRetentionMs: 0, compaction: { enabled: false, keepRecentTokens } },
    onChanged: vi.fn(),
    onReport: vi.fn(),
  });
  cleanup.push(() => engine.close());
  const submit = (text: string, requestId: string) =>
    engine.root.submit({ type: "input", content: text, requestId }, BACKGROUND_CONTEXT);
  const send = async (text: string, requestId: string) => {
    const input = await submit(text, requestId);
    return input.wait(BACKGROUND_CONTEXT);
  };
  return {
    ...f,
    engine,
    summarize,
    submit,
    send,
    view: () => engine.index(new AbortController().signal),
    zoom: (id: number, n: number) => engine.memory.zoom(id, n, new AbortController().signal),
    budget: (value: number) => {
      budget = value;
    },
  };
}

it("projects Cake-authored report provenance from originals without classifying spoofed user text", async () => {
  const f = await fixture();
  const report = durableInputText(researchMarkdown, [], true, false, researchOrigin);
  expect(durableInputPresentation(markDurableInputSteering(report)).subagentReport).toEqual(
    researchOrigin,
  );
  await f.send(report, "report");
  const spoof = report + "\nWorker provenance: " + JSON.stringify(researchOrigin);
  await f.send(durableInputText(spoof, [], false), "spoof");
  const page = await readDurableOriginalPage(f.engine.root);
  const originals = page.parts.filter((part) => part.kind === "text" && part.role === "user");
  expect(originals).toHaveLength(2);
  expect(originals[0]).toMatchObject({
    text: researchMarkdown,
    renderAs: "markdown",
    subagentReport: researchOrigin,
  });
  expect(originals[1]).toMatchObject({ text: spoof });
  expect(
    originals[1] && "subagentReport" in originals[1] ? originals[1].subagentReport : undefined,
  ).toBeUndefined();
  expect((await readDurableOriginalPage(f.engine.root)).parts).toEqual(page.parts);
  expect(JSON.stringify(f.requests)).toContain('"cost":0.25'.replaceAll('"', '\\"'));
});

it.each(["complete", "error", "aborted"] as const)(
  "retains the full assignment, provenance and %s findings through durable delivery and replay",
  async (status) => {
    const f = await fixture();
    const origin = { ...investigatorOrigin, status };
    const findings =
      status === "complete"
        ? "Verified the session's reported checks."
        : status === "error"
          ? "Permission denied reading the transcript."
          : "Investigation cancelled with no verified findings.";
    const text = subagentCompletionMessage({
      handleId: origin.handleId,
      task: origin.task,
      status,
      resolvedModel: { ...origin.resolvedModel, fallbacks: [] },
      fastMode: false,
      streaming: false,
      parts:
        status === "complete"
          ? [{ id: "answer", kind: "text", role: "assistant", text: findings, status: "complete" }]
          : [],
      error: findings,
    });
    await f.send(durableInputText(text, [], true, false, origin), "completion");
    const page = await readDurableOriginalPage(f.engine.root);
    const report = page.parts.find((part) => part.kind === "text" && part.subagentReport);
    expect(report).toMatchObject({ text, subagentReport: origin });
    expect((await readDurableOriginalPage(f.engine.root)).parts).toEqual(page.parts);
    const context = JSON.stringify(f.requests);
    expect(context).toContain(origin.task.slice(-150));
    expect(context).toContain(findings);
    expect(context).toContain(origin.handleId);
    expect(context).toContain("Worker provenance:");
  },
);

it("refreshes independent runs, retains zoom originals through tool rounds, and keeps instructions outside memory", async () => {
  const original = `ORIGINAL_DETAIL ${"verbatim words ".repeat(100)}`;
  const f = await fixture((_request, index) =>
    index === 1
      ? durableAnswer(original)
      : index === 2
        ? durableAnswer("", [
            { type: "toolCall", id: "zoom-1", name: "zoom", arguments: { id: 1, n: 1 } },
          ])
        : durableAnswer("Finished"),
  );
  const result = await f.send("Remember this", "first");
  expect(result.status, JSON.stringify(result)).toBe("done");
  await f.engine.root.configure(
    { instructions: "<cake-chat-instructions>Never use worktrees</cake-chat-instructions>" },
    BACKGROUND_CONTEXT,
  );
  await f.send("What were the exact words?", "second");
  expect(JSON.stringify(f.requests[1])).toContain("<chat>");
  expect(JSON.stringify(f.requests[1])).not.toContain(original);
  expect(JSON.stringify(f.requests[1])).toContain("Never use worktrees");
  expect(JSON.stringify(f.requests[2])).toContain(original);
  await f.send("New topic", "third");
  expect(JSON.stringify(f.requests.at(-1))).not.toContain(original);
  expect((await f.zoom(1, 1)).text).toContain(original);
  const page = await readDurableOriginalPage(f.engine.root);
  expect(JSON.stringify(page.parts)).toContain(original);
  expect(JSON.stringify(page.parts)).not.toContain("<chat>");
  expect((await f.view()).text).not.toContain("Never use worktrees");
});

it("keeps Cake Chat's canonical instructions across compaction and ordinary run checkpoints", async () => {
  const f = await fixture(undefined, 1);
  await f.send("First question", "first");
  const systemCount = async () =>
    (await f.engine.root.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items.filter(
      (entry) => entry.kind === "pi.system",
    ).length;
  const initialCount = await systemCount();
  await f.send("Ordinary continuation, no compaction", "ordinary");
  const count = await systemCount();
  expect(count).toBe(initialCount + 1);
  const before = await readDurableOriginalPage(f.engine.root);
  const job = await f.engine.root.compact(undefined, BACKGROUND_CONTEXT);
  await f.engine.harness.waitForTask(job, BACKGROUND_CONTEXT);
  const compacted = await f.engine.root.context(BACKGROUND_CONTEXT);
  expect(JSON.stringify(compacted.messages)).toContain("Always use worktrees");
  expect(await systemCount()).toBe(count);
  expect((await readDurableOriginalPage(f.engine.root)).parts).toEqual(before.parts);
  await f.send("After compaction", "second");
  expect(JSON.stringify(f.requests.at(-1))).toContain("Always use worktrees");
  // Durable deliberately writes one baseline after any head marker, including
  // Cake's ordinary per-run resets. It is not an added reminder or UI injection.
  expect(await systemCount()).toBe(count + 1);
  expect(f.requests.at(-1)!.messages.filter((message) => message.role === "system")).toHaveLength(
    1,
  );
  expect(
    (await readDurableOriginalPage(f.engine.root)).parts.filter((part) => part.kind === "context"),
  ).toHaveLength(0);
  await f.engine.root.configure(
    { instructions: "Genuinely changed Cake Chat instructions" },
    BACKGROUND_CONTEXT,
  );
  await f.send("After changing instructions", "third");
  expect(JSON.stringify(f.requests.at(-1))).toContain("Genuinely changed Cake Chat instructions");
  expect(await systemCount()).toBe(count + 2);
});

it("stops a turn waiting behind background memory indexing without withdrawing queued input", async () => {
  const f = await fixture();
  await f.send("Hello", "first");
  const summary = Promise.withResolvers<string>();
  f.summarize.mockImplementation(() => summary.promise);
  let stop: Promise<void> | undefined;
  try {
    await f.send("LONG_DETAIL ".repeat(100), "long");
    await vi.waitFor(() => expect(f.summarize).toHaveBeenCalled());
    const active = await f.submit("Waiting for memory", "waiting");
    // Request preparation has parked its fresh head but cannot reach the provider
    // while the preceding background summary holds the serial indexing worker.
    await vi.waitFor(async () => {
      const context = await f.engine.root.context(BACKGROUND_CONTEXT);
      expect(JSON.stringify(context.messages)).toContain("Waiting for memory");
      expect(JSON.stringify(context.messages)).not.toContain("LONG_DETAIL");
    });
    const queued = await f.submit("Keep this queued", "queued");
    let stopped = false;
    stop = abortDurableActiveTurn(f.engine.harness, f.engine.root).then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(stopped).toBe(true));
    await stop;
    expect(await active.wait(BACKGROUND_CONTEXT)).toMatchObject({
      status: "unanswered",
      reason: "aborted",
    });
    expect(
      (await f.engine.harness.snapshot(LiveDoc, f.engine.root.id, BACKGROUND_CONTEXT))?.run,
    ).toBeUndefined();
    expect(
      (await f.engine.harness.snapshot(InboxDoc, f.engine.root.id, BACKGROUND_CONTEXT))?.items,
    ).toMatchObject([{ id: queued.id }]);
    expect(f.requests).toHaveLength(2);
  } finally {
    summary.resolve("user: original details remain available through zoom");
    await stop;
  }
  await f.send("Try again after stopping", "retry");
  expect(f.requests).toHaveLength(4);
  expect(JSON.stringify(f.requests[2])).toContain("Keep this queued");
  expect(JSON.stringify(f.requests[3])).toContain("Try again after stopping");
});

it("deduplicates committed input without starting another model run", async () => {
  const f = await fixture();
  const first = await f.submit("Hello", "unique");
  await first.wait(BACKGROUND_CONTEXT);
  const again = await f.submit("Hello", "unique");
  expect(again.id).toBe(first.id);
  expect(f.requests).toHaveLength(1);
  expect((await f.view()).sourceCount).toBe(2);
});

it("bounds the persisted active head and lower memory views while lazily retaining ancient originals", async () => {
  const f = await fixture();
  f.budget(3_072);
  for (let i = 0; i < 36; i += 1) await f.send(`request-${i}: ${"details ".repeat(12)}`, String(i));
  const view = await f.view();
  expect(view.bytes).toBeLessThanOrEqual(3_072);
  expect(view.sourceCount).toBe(72);
  expect(view.partCount).toBeLessThan(72);
  expect((await f.zoom(0, 1)).text).toContain("request-0");
  f.budget(2_048);
  expect((await f.view()).bytes).toBeLessThanOrEqual(2_048);
  expect((await f.zoom(0, 64)).text).toContain("0+32|");
  expect((await f.zoom(0, 64)).text).toContain("32+32|");
  const active = await f.engine.root.context(BACKGROUND_CONTEXT);
  expect(JSON.stringify(active.messages)).not.toContain('"content":"request-0:');
  expect(Buffer.byteLength(JSON.stringify(active.messages))).toBeLessThan(8_000);
});

it("pages originals once without resets, clocks or summary nodes", async () => {
  const f = await fixture();
  for (let i = 0; i < 45; i += 1) await f.send(`message-${i}`, String(i));
  await f.view();
  let cursor: string | undefined;
  const ids: string[] = [];
  do {
    const page = await readDurableOriginalPage(f.engine.root, cursor);
    ids.push(...page.parts.filter((part) => part.kind === "text").map((part) => part.id));
    expect(JSON.stringify(page.parts)).not.toContain("<chat>");
    cursor = page.cursor;
  } while (cursor !== undefined);
  expect(ids).toHaveLength(90);
  expect(new Set(ids).size).toBe(90);
});

it("admits before failing summarization, parks a bounded head and recovers without losing originals", async () => {
  const f = await fixture();
  await f.send("Hello", "first");
  const original = "USER_DETAIL ".repeat(100);
  f.summarize.mockRejectedValue(new Error("Summarizer unavailable"));
  await f.send(original, "long");
  const accepted = await f.submit("Continue", "accepted-before-summary");
  const failed = await accepted.wait(BACKGROUND_CONTEXT);
  expect(failed).toMatchObject({ status: "unanswered", reason: "model_error" });
  expect(f.requests).toHaveLength(2);
  expect(JSON.stringify((await f.engine.root.context(BACKGROUND_CONTEXT)).messages)).not.toContain(
    original,
  );
  expect(JSON.stringify((await readDurableOriginalPage(f.engine.root)).parts)).toContain(
    "Continue",
  );
  f.summarize.mockResolvedValue("user: precise original details remain on disk");
  await f.send("Try again", "retry");
  expect((await f.view()).sourceCount).toBe(8);
  expect((await f.zoom(2, 1)).text).toContain(original);
});
