import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ResetEntry,
  ToolResultEntry,
  UserEntry,
  createRegistry,
  defineEntry,
  defineExtension,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDurableConversationRecallTools,
  durableConversationRecallInstructions,
} from "../../../../src/services/pi-durable/durable-conversation-recall";
import { openDurableChatEngine } from "../../../../src/services/pi-durable/durable-chat-engine";
import { durableInputText } from "../../../../src/services/pi-durable/durable-input-presentation";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";
import { researchOrigin } from "../../../fixtures/subagent-report";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const sessionId = CAKE_CHAT_SESSION_ID;
const conversationRef = `cake://session/${sessionId}`;
async function fixture(
  storage: Storage = new MemoryStorage(),
  answer?: Parameters<typeof durableModels>[0],
) {
  const models = durableModels(answer);
  const tools = createDurableConversationRecallTools({ sessionId, storage });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "recall", tools: [...tools] }));
  const engine = await openDurableChatEngine({
    storage,
    models: models.models,
    registry,
    agent: {
      model: { provider: "fixture", modelId: "fixture" },
      instructions: durableConversationRecallInstructions(sessionId),
      tools: [...tools],
    },
    memory: { budget: () => 4_000, summarize: async () => "user: compressed decision" },
    settings: { contextRetentionMs: 0 },
    onChanged: vi.fn(),
    onReport: vi.fn(),
  });
  cleanup.push(() => engine.close());
  // Only the conversation identity is used by the read-only tools; execution itself
  // is also exercised through the real Harness in the tool-round case below.
  const api = { conversationId: engine.root.id } as Parameters<(typeof tools)[0]["execute"]>[1];
  return {
    engine,
    models,
    api,
    tools,
    async search(input: Parameters<(typeof tools)[0]["execute"]>[0] = {}) {
      const result = await tools[0].execute(input, api, BACKGROUND_CONTEXT);
      return JSON.parse(
        result.output?.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ??
          "null",
      );
    },
    async read(input: Parameters<(typeof tools)[1]["execute"]>[0]) {
      const result = await tools[1].execute(input, api, BACKGROUND_CONTEXT);
      return JSON.parse(
        result.output?.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("") ??
          "null",
      );
    },
    append: (text: string) =>
      engine.root.commit(
        (tx) =>
          tx.appendEntry(UserEntry, engine.root.id, {
            model: [{ role: "user", content: text, timestamp: 1 }],
          }),
        BACKGROUND_CONTEXT,
      ),
  };
}

it("searches originals outside memory and reads dialogue, tool arguments and failure evidence without changing the head", async () => {
  const f = await fixture();
  const user = await f.append("We chose the violet storage plan.");
  const records = await f.engine.root.commit(async (tx) => {
    const call = await tx.appendEntry(AssistantEntry, f.engine.root.id, {
      model: [
        durableAnswer("", [
          { type: "toolCall", id: "call-1", name: "inspect", arguments: { path: "violet.config" } },
          { type: "thinking", thinking: "PRIVATE_REASONING" },
        ]),
      ],
    });
    const result = await tx.appendEntry(ToolResultEntry, f.engine.root.id, {
      data: {
        diagnostics: [{ severity: "error", code: "interrupted", message: "execution interrupted" }],
      },
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "inspect",
          isError: true,
          content: [
            { type: "text", text: "violet output" },
            { type: "image", mimeType: "image/png", data: "BINARY_PAYLOAD" },
          ],
          details: { status: "awaiting-agent" },
          timestamp: 1234,
          durationMs: 12,
        },
      ],
    });
    const report = await tx.appendEntry(UserEntry, f.engine.root.id, {
      model: [
        {
          role: "user",
          content: durableInputText("violet worker report", [], true, false, researchOrigin),
          timestamp: 2,
        },
      ],
    });
    return { call, result, report };
  }, BACKGROUND_CONTEXT);
  const view = await f.engine.index(new AbortController().signal);
  expect(view.sourceCount).toBe(2); // dialogue + report; the tool-only entries have no memory leaves
  await f.engine.root.commit(
    (tx) =>
      tx.appendEntry(ResetEntry, f.engine.root.id, {
        head: "self",
        model: [{ role: "user", content: "Compressed history only", timestamp: 5 }],
      }),
    BACKGROUND_CONTEXT,
  );
  const before = await f.engine.root.context(BACKGROUND_CONTEXT);
  const found = await f.search({ query: "VIOLET" });
  expect(found).toMatchObject({ conversationRef, complete: true, nextAfterEntryId: null });
  expect(found.matches.map((match: { entryId: number }) => match.entryId)).toEqual([
    user.id,
    records.call.id,
    records.result.id,
    records.report.id,
  ]);
  expect(await f.read({ entryId: user.id })).toMatchObject({
    conversationRef,
    text: "We chose the violet storage plan.",
    role: "user",
  });
  const call = JSON.parse((await f.read({ entryId: records.call.id, section: "record" })).text);
  expect(call.message.content).toEqual([
    { type: "toolCall", id: "call-1", name: "inspect", arguments: { path: "violet.config" } },
  ]);
  const result = JSON.parse((await f.read({ entryId: records.result.id, section: "record" })).text);
  expect(result).toMatchObject({
    message: {
      toolCallId: "call-1",
      isError: true,
      details: { status: "awaiting-agent" },
      timestamp: 1234,
      durationMs: 12,
    },
    data: { diagnostics: [{ code: "interrupted" }] },
  });
  expect(JSON.stringify(result)).not.toContain("BINARY_PAYLOAD");
  const report = await f.read({ entryId: records.report.id });
  expect(report.text).toContain("Worker provenance:");
  expect(report.text).toContain(researchOrigin.handleId);
  expect((await f.search({ query: "PRIVATE_REASONING" })).matches).toEqual([]);
  expect((await f.search({ query: "BINARY_PAYLOAD" })).matches).toEqual([]);
  expect(await f.engine.root.context(BACKGROUND_CONTEXT)).toEqual(before);
});

it("matches literal paths, quotes and newlines and applies role filters before pagination", async () => {
  const f = await fixture();
  const literal = 'C:\\work\\"quoted"\nsecond line';
  const user = await f.append(literal);
  await f.engine.root.commit(
    (tx) =>
      tx.appendEntry(AssistantEntry, f.engine.root.id, {
        model: [
          durableAnswer("", [
            { type: "toolCall", id: "literal", name: "inspect", arguments: { path: literal } },
          ]),
        ],
      }),
    BACKGROUND_CONTEXT,
  );
  expect((await f.search({ query: literal })).matches).toHaveLength(2);
  expect((await f.search({ query: literal, role: "user", limit: 1 })).matches).toMatchObject([
    { entryId: user.id },
  ]);
  expect((await f.search({ query: literal, role: "toolResult" })).matches).toEqual([]);
});

it("uses memory-derived inclusive bounds to search only a summary's originals across pages", async () => {
  const f = await fixture();
  const a = await f.append("needle first ".repeat(100));
  const tool = await f.engine.root.commit(
    (tx) =>
      tx.appendEntry(ToolResultEntry, f.engine.root.id, {
        data: { diagnostics: [] },
        model: [
          {
            role: "toolResult",
            toolCallId: "bounded",
            toolName: "inspect",
            content: [{ type: "text", text: "needle tool evidence" }],
            isError: false,
            timestamp: 2,
          },
        ],
      }),
    BACKGROUND_CONTEXT,
  );
  const b = await f.append("needle second ".repeat(100));
  await f.append("needle outside third ".repeat(100));
  await f.append("needle outside fourth ".repeat(100));
  const view = await f.engine.index(new AbortController().signal, undefined, 140);
  expect(view.partCount).toBe(1);
  const zoom = await f.engine.memory.zoom(0, 4, new AbortController().signal);
  const anchor = /^0\+2\|\[originals=(\d+)\.\.(\d+)\]/.exec(zoom.text)!;
  expect(anchor).not.toBeNull();
  const bounds = { fromEntryId: Number(anchor[1]), throughEntryId: Number(anchor[2]) };
  expect(bounds).toEqual({ fromEntryId: a.id, throughEntryId: b.id });
  // Recover the indexed dialogue through Zoom, then supplement it with retained
  // tool evidence inside the original-entry bounds, not the memory coordinates.
  const dialogue = await f.engine.memory.zoom(0, 1, new AbortController().signal);
  expect(dialogue.text).toContain("needle first");
  expect(dialogue.text).not.toContain("needle tool evidence");
  const first = await f.search({ ...bounds, query: "needle", limit: 1 });
  expect(first).toMatchObject({ ...bounds, matches: [{ entryId: a.id }], complete: false });
  const rest = await f.search({ ...bounds, query: "needle", afterEntryId: first.nextAfterEntryId });
  expect(rest).toMatchObject({ complete: true, nextAfterEntryId: null });
  expect(rest.matches.map((match: { entryId: number }) => match.entryId)).toEqual([tool.id, b.id]);
  const record = JSON.parse((await f.read({ entryId: tool.id, section: "record" })).text);
  expect(record.message).toMatchObject({
    role: "toolResult",
    toolCallId: "bounded",
    content: [{ type: "text", text: "needle tool evidence" }],
    isError: false,
  });
  expect((await f.search({ ...bounds, afterEntryId: 0 })).matches).toHaveLength(3);
  expect((await f.search({ fromEntryId: b.id, throughEntryId: b.id })).matches).toMatchObject([
    { entryId: b.id },
  ]);
  await expect(f.search({ fromEntryId: b.id, throughEntryId: a.id })).rejects.toThrow(
    "fromEntryId must not exceed throughEntryId",
  );
  expect(durableConversationRecallInstructions(sessionId)).toContain(
    "fromEntryId=A and throughEntryId=B",
  );
});

it("paginates matches with a fixed high water mark and can browse surrounding originals", async () => {
  const f = await fixture();
  const a = await f.append("needle first");
  const b = await f.append("context between matches");
  const c = await f.append("needle last");
  const first = await f.search({ query: "needle", limit: 1 });
  expect(first).toMatchObject({
    matches: [{ entryId: a.id }],
    complete: false,
    nextAfterEntryId: a.id,
  });
  await f.append("needle added later");
  const second = await f.search({
    query: "needle",
    limit: 1,
    afterEntryId: first.nextAfterEntryId,
    throughEntryId: first.throughEntryId,
  });
  expect(second).toMatchObject({
    matches: [{ entryId: c.id }],
    complete: true,
    nextAfterEntryId: null,
  });
  const around = await f.search({ afterEntryId: a.id, throughEntryId: c.id });
  expect(around.matches.map((match: { entryId: number }) => match.entryId)).toEqual([b.id, c.id]);
});

it("bounds sparse scans and distinguishes an unfinished search from an exhaustive negative", async () => {
  const f = await fixture();
  const bookkeeping = defineEntry("test.bookkeeping");
  await f.engine.root.commit(async (tx) => {
    for (let i = 0; i < 1_005; i++) await tx.appendEntry(bookkeeping, f.engine.root.id, {});
  }, BACKGROUND_CONTEXT);
  const target = await f.append("only distant match");
  const first = await f.search({ query: "distant" });
  expect(first).toMatchObject({ scannedEntries: 1_000, matches: [], complete: false });
  const last = await f.search({
    query: "distant",
    afterEntryId: first.nextAfterEntryId,
    throughEntryId: first.throughEntryId,
  });
  expect(last).toMatchObject({
    complete: true,
    nextAfterEntryId: null,
    matches: [{ entryId: target.id }],
  });
});

it("pages exact text and JSON without claiming a partial slice is complete", async () => {
  const f = await fixture();
  const text = "long original 日本語 😀\n".repeat(400);
  const entry = await f.append(text);
  let offset: number | null = 0;
  let recovered = "";
  while (offset !== null) {
    const page = await f.read({ entryId: entry.id, offset, maxChars: 137 });
    expect(page.text.length).toBeLessThanOrEqual(137);
    expect(page.totalChars).toBe(text.length);
    recovered += page.text;
    if (page.nextOffset !== null) expect(page.truncated).toBe(true);
    offset = page.nextOffset;
  }
  expect(recovered).toBe(text);
  const record = await f.read({ entryId: entry.id, section: "record", maxChars: 40 });
  expect(record).toMatchObject({ section: "record", nextOffset: 40, truncated: true });
  await expect(f.read({ entryId: entry.id, offset: text.length + 1 })).rejects.toThrow(
    "Offset exceeds",
  );
});

it("rejects non-original entries, other conversations, and side-chat callers", async () => {
  const f = await fixture();
  const reset = await f.engine.root.commit(
    (tx) => tx.appendEntry(ResetEntry, f.engine.root.id, { head: "self" }),
    BACKGROUND_CONTEXT,
  );
  await expect(f.read({ entryId: reset.id })).rejects.toThrow("Original entry does not exist");
  const other = await f.engine.root.fork(
    reset.id,
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  );
  const privateEntry = await other.commit(
    (tx) =>
      tx.appendEntry(UserEntry, other.id, {
        model: [{ role: "user", content: "other conversation", timestamp: 1 }],
      }),
    BACKGROUND_CONTEXT,
  );
  await expect(f.read({ entryId: privateEntry.id })).rejects.toThrow(
    "Original entry does not exist",
  );
  const sideApi = { ...f.api, conversationId: other.id };
  await expect(f.tools[0].execute({}, sideApi, BACKGROUND_CONTEXT)).rejects.toThrow(
    "owning Cake Chat",
  );
  await expect(
    f.tools[1].execute({ entryId: privateEntry.id }, sideApi, BACKGROUND_CONTEXT),
  ).rejects.toThrow("owning Cake Chat");
  expect((await f.search({ query: "other conversation" })).matches).toEqual([]);
});

it("keeps the stable reference, original lookup and memory state across SQLite reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cake-recall-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, "chat.sqlite");
  const first = await fixture(await openNodeSqliteStorage(database));
  const entry = await first.append("restart-stable original");
  const view = await first.engine.index(new AbortController().signal);
  await first.engine.close();
  cleanup.pop();
  const reopened = await fixture(await openNodeSqliteStorage(database));
  expect(await reopened.engine.index(new AbortController().signal)).toEqual(view);
  expect(await reopened.read({ entryId: entry.id })).toMatchObject({
    conversationRef,
    ref: `${conversationRef}?message=${entry.id}`,
    text: "restart-stable original",
  });
  const input = await reopened.engine.root.submit(
    { type: "input", content: "Continue", requestId: "reopen" },
    BACKGROUND_CONTEXT,
  );
  await input.wait(BACKGROUND_CONTEXT);
  expect(JSON.stringify(reopened.models.requests.at(-1))).toContain(conversationRef);
  expect(JSON.stringify(reopened.models.requests.at(-1))).toContain("conversation_search");
});

it("keeps the largest escaped text page valid through SDK output limits", async () => {
  let targetId = 0;
  const f = await fixture(new MemoryStorage(), (_request, index) =>
    index === 1
      ? durableAnswer("", [
          {
            type: "toolCall",
            id: "bounded",
            name: "conversation_read",
            arguments: { entryId: targetId, maxChars: 8_000 },
          },
        ])
      : durableAnswer("Done"),
  );
  targetId = (await f.append("\u0000".repeat(9_000))).id;
  const input = await f.engine.root.submit(
    { type: "input", content: "Read a page", requestId: "bounded" },
    BACKGROUND_CONTEXT,
  );
  await input.wait(BACKGROUND_CONTEXT);
  const result = f.models.requests
    .at(-1)
    ?.messages.find((message) => message.role === "toolResult" && message.toolCallId === "bounded");
  expect(result).toMatchObject({ isError: false });
  if (result?.role !== "toolResult") throw new Error("Missing tool result");
  const text = result.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  expect(JSON.parse(text)).toMatchObject({ nextOffset: 8_000, totalChars: 9_000 });
});

it("validates retrieval bounds in the real tool loop", async () => {
  const f = await fixture(new MemoryStorage(), (_request, index) =>
    index === 1
      ? durableAnswer("", [
          {
            type: "toolCall",
            id: "bad-search",
            name: "conversation_search",
            arguments: { limit: 21 },
          },
          {
            type: "toolCall",
            id: "bad-read",
            name: "conversation_read",
            arguments: { entryId: 0, maxChars: 8_001 },
          },
        ])
      : durableAnswer("Done"),
  );
  const input = await f.engine.root.submit(
    { type: "input", content: "Invalid requests", requestId: "invalid" },
    BACKGROUND_CONTEXT,
  );
  await input.wait(BACKGROUND_CONTEXT);
  const results = f.models.requests
    .at(-1)
    ?.messages.filter((message) => message.role === "toolResult");
  expect(results).toHaveLength(2);
  for (const result of results ?? []) {
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Validation failed for tool");
  }
});

it("executes recall through the real tool loop and keeps guidance through context compaction", async () => {
  let targetId = 0;
  const f = await fixture(new MemoryStorage(), (_request, index) =>
    index === 1
      ? durableAnswer("", [
          {
            type: "toolCall",
            id: "recall",
            name: "conversation_read",
            arguments: { entryId: targetId },
          },
        ])
      : durableAnswer("Recalled the original."),
  );
  targetId = (await f.append("verbatim evidence before compaction")).id;
  const compact = await f.engine.root.compact(undefined, BACKGROUND_CONTEXT);
  await f.engine.harness.waitForTask(compact, BACKGROUND_CONTEXT);
  const input = await f.engine.root.submit(
    { type: "input", content: "Recall the exact wording", requestId: "recall" },
    BACKGROUND_CONTEXT,
  );
  await input.wait(BACKGROUND_CONTEXT);
  const requests = JSON.stringify(f.models.requests);
  expect(requests).toContain("verbatim evidence before compaction");
  expect(requests).toContain(conversationRef);
  expect(requests).toContain("inclusive original-entry range");
  expect(requests).toContain("fromEntryId=A and throughEntryId=B");
  const page = await f.engine.root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  const result = page.items
    .flatMap((entry) => entry.model ?? [])
    .find((message) => message.role === "toolResult" && message.toolCallId === "recall");
  expect(result).toMatchObject({ isError: false });
  expect(JSON.stringify(result)).toContain("verbatim evidence before compaction");
});
