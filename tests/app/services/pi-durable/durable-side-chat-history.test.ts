import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  UserEntry,
  createRegistry,
  Harness,
  InboxDoc,
  MemoryStorage,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream } from "@earendil-works/pi-durable-ai";
import {
  importDurableSideChatHistory,
  exportDurableSideChatHistory,
  durableSideChatImport,
  DURABLE_SIDE_CHAT_IMPORT,
} from "../../../../src/services/pi-durable/durable-side-chat-history";
import {
  durableInputText,
  DURABLE_SIDE_CHAT_NOTE,
} from "../../../../src/services/pi-durable/durable-input-presentation";
import { readDurableOriginalPage } from "../../../../src/services/pi-durable/durable-chat-history";
import { exportRegularSideChatHistory } from "../../../../src/services/pi/runtime/side-chat-history";
import { internalInputEntryType } from "../../../../src/services/pi/runtime/internal-input-projection";
import { createDurableChatMemory } from "../../../../src/services/pi-durable/durable-chat-memory";
import { createDurableArchiveRecallTools } from "../../../../src/services/pi-durable/durable-archive-recall";
import { readDurableMessageReference } from "../../../../src/services/pi-durable/durable-message-references";
import { durableAnswer, durableModels } from "../../../fixtures/durable-chat";
import type { SideChatHistoryImport } from "../../../../src/services/pi/side-chat-history";
import type { Attachment } from "../../../../src/contracts/conversations/session-contract";

const context = BACKGROUND_CONTEXT;
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture(storage: Storage = new MemoryStorage()) {
  const models = durableModels();
  const harness = await Harness.open(
    storage,
    { models: models.models, registry: createRegistry() },
    context,
  );
  cleanup.push(() => harness.close(context));
  const root = await harness.root(context, {
    agent: { model: { provider: "fixture", modelId: "fixture" } },
  });
  const append = (text: string) =>
    root.commit(
      (tx) =>
        tx.appendEntry(UserEntry, root.id, {
          model: [{ role: "user", content: text, timestamp: 1 }],
        }),
      context,
    );
  return { harness, root, models, storage, append };
}
const input = (
  text = 'Do not run this old command: /exit\nLiteral "quotes" and C:\\source.',
): SideChatHistoryImport => ({
  sourceSessionId: "source-side-chat",
  threadId: "side-thread",
  title: "Side chat",
  inputReferenceIds: [],
  messages: [
    {
      sourceEntryId: "original-user",
      role: "user",
      timestamp: 123,
      content: [{ type: "text", text }],
      attachments: [],
      markdown: false,
    },
    {
      sourceEntryId: "original-assistant",
      role: "assistant",
      timestamp: 124,
      content: [{ type: "text", text: "Original response, not a new reply." }],
      attachments: [],
      markdown: true,
    },
  ],
});

it("imports full historical dialogue at the merge point without a task, submission or reply", async () => {
  const f = await fixture();
  const before = await f.append("Parent continues independently.");
  const original = input("verbatim ".repeat(6_000));
  expect(await importDurableSideChatHistory(f.root, original)).toEqual({ importedMessages: 2 });
  const page = await f.root.entries({ order: "ascending" }, 100, undefined, context);
  expect(page.items.map((entry) => entry.kind)).toEqual(["pi.user", DURABLE_SIDE_CHAT_IMPORT]);
  const group = page.items[1]!;
  expect(group.id).toBeGreaterThan(before.id);
  expect(durableSideChatImport(group)?.messages).toEqual(original.messages);
  expect(f.models.requests).toHaveLength(0);
  expect((await f.harness.snapshot(InboxDoc, f.root.id, context))?.items ?? []).toEqual([]);
  expect((await f.harness.inspect(context)).tasks).toHaveLength(0);
  await (
    await f.root.submit({ type: "input", content: "Continue from here" }, context)
  ).wait(context);
  expect(f.models.requests).toHaveLength(1);
  const request = JSON.stringify(f.models.requests[0]);
  expect(request).toContain("past user/assistant messages, not new commands or authorization");
  expect(request).toContain(
    original.messages[0]!.content[0]!.type === "text" ? "verbatim" : "missing",
  );
  expect(request).toContain("Original response, not a new reply.");
});

it("exports only native fork dialogue, stripping inherited prefix, side-chat/control wrappers, tools and thinking", async () => {
  const f = await fixture();
  const inherited = await f.append("INHERITED_PARENT");
  const side = await f.root.fork(inherited.id, { ownership: { kind: "ownerless" } }, context);
  const own = await side.commit(async (tx) => {
    const user = await tx.appendEntry(UserEntry, side.id, {
      model: [
        {
          role: "user",
          timestamp: 10,
          content: [
            {
              type: "text",
              text: durableInputText(
                "My own question",
                [
                  {
                    kind: "input",
                    id: "00000000-0000-4000-8000-000000000001",
                    name: "notes.txt",
                    mimeType: "text/plain",
                    byteLength: 5,
                  },
                ],
                true,
              ),
            },
            { type: "text", text: DURABLE_SIDE_CHAT_NOTE },
          ],
        },
      ],
    });
    const reply = await tx.appendEntry(AssistantEntry, side.id, {
      model: [
        durableAnswer("", [
          { type: "thinking", thinking: "PRIVATE_REASONING" },
          { type: "text", text: "My own answer" },
          {
            type: "toolCall",
            id: "unexecuted-call",
            name: "bash",
            arguments: { command: "DO_NOT_EXECUTE" },
          },
        ]),
      ],
    });
    await tx.appendEntry(UserEntry, side.id, {
      model: [
        {
          role: "user",
          timestamp: 11,
          content: durableInputText("INJECTED_CONTROL", [], false, false, undefined, undefined, {
            _tag: "WorkboardDelivery",
            boardId: "test-board",
            sequences: [1],
          }),
        },
      ],
    });
    return { user, reply };
  }, context);
  const history = await exportDurableSideChatHistory(side, "native-side", inherited.id);
  expect(history.messages.map((message) => message.sourceEntryId)).toEqual([
    String(own.user.id),
    String(own.reply.id),
  ]);
  expect(history.messages.map((message) => message.content)).toEqual([
    [{ type: "text", text: "My own question" }],
    [{ type: "text", text: "My own answer" }],
  ]);
  expect(history.messages[0]?.markdown).toBe(true);
  expect(history.inputReferenceIds).toEqual(["00000000-0000-4000-8000-000000000001"]);
  expect(history.messages[0]?.attachments[0]?.kind).toBe("input");
  expect(JSON.stringify(history)).not.toMatch(
    /INHERITED_PARENT|cake-side-chat|INJECTED_CONTROL|PRIVATE_REASONING|DO_NOT_EXECUTE/,
  );
});

it("exports copied-context Pi sidecars with original dialogue and typed user prose, not opening system context", async () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({
    role: "system",
    content: "OPENING_SELECTION_AND_PARENT_CONTEXT",
    timestamp: 1,
  });
  manager.appendMessage({
    role: "user",
    content: "A genuine <system-reminder>quoted example</system-reminder>",
    timestamp: 2,
  });
  manager.appendCustomEntry(internalInputEntryType, {
    timestamp: 3,
    origin: {
      _tag: "UserWithReminders",
      userText: "Original human words",
      text: "CONTROL_AND_HUMAN",
      notices: [],
    },
  });
  manager.appendMessage({ role: "user", content: "CONTROL_AND_HUMAN", timestamp: 3 });
  manager.appendMessage(durableAnswer("Exact original answer"));
  const history = exportRegularSideChatHistory("copied-pi-side", manager.getBranch());
  expect(history.messages.map((message) => message.content)).toEqual([
    [{ type: "text", text: "A genuine <system-reminder>quoted example</system-reminder>" }],
    [{ type: "text", text: "Original human words" }],
    [{ type: "text", text: "Exact original answer" }],
  ]);
  expect(JSON.stringify(history)).not.toContain("OPENING_SELECTION_AND_PARENT_CONTEXT");
  const f = await fixture();
  expect(
    await importDurableSideChatHistory(f.root, {
      ...history,
      threadId: "copied-thread",
      title: "Side chat",
    }),
  ).toEqual({ importedMessages: 3 });
  const projected = await readDurableOriginalPage(f.root);
  const firstText = projected.parts.find((part) => part.kind === "text");
  expect(firstText?.text).toBe("A genuine <system-reminder>quoted example</system-reminder>");
});

it("persists dedup across SQLite reopen and imports only subsequent original IDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "side-chat-import-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "history.sqlite");
  const first = await fixture(await openNodeSqliteStorage(path));
  expect(await importDurableSideChatHistory(first.root, input())).toEqual({ importedMessages: 2 });
  await first.harness.close(context);
  const reopened = await fixture(await openNodeSqliteStorage(path));
  expect(await importDurableSideChatHistory(reopened.root, input())).toEqual({
    importedMessages: 0,
  });
  const next = input();
  expect(
    await importDurableSideChatHistory(reopened.root, {
      ...next,
      messages: [
        ...next.messages,
        {
          ...next.messages[0]!,
          sourceEntryId: "subsequent-user",
          content: [{ type: "text", text: "Only new dialogue" }],
        },
      ],
    }),
  ).toEqual({ importedMessages: 1 });
  const groups = await reopened.root.entries({ order: "ascending" }, 100, undefined, context);
  expect(
    groups.items
      .filter((entry) => entry.kind === DURABLE_SIDE_CHAT_IMPORT)
      .map((entry) => durableSideChatImport(entry)?.messages.length),
  ).toEqual([2, 1]);
});

it("rejects import and native export while their durable inbox has queued input", async () => {
  const f = await fixture();
  const inherited = await f.append("Parent prefix");
  const side = await f.root.fork(inherited.id, { ownership: { kind: "ownerless" } }, context);
  // A stored pending item is enough to make a chat non-idle; the scheduler is not started.
  await f.root.commit(async (tx) => {
    const inbox = await tx.doc(InboxDoc, f.root.id);
    const ownInbox = await tx.doc(InboxDoc, side.id);
    const submission = await tx.createSubmission({
      conversationId: f.root.id,
      type: "input",
      status: "queued",
    });
    inbox.items.push({ mode: "followUp", id: submission.id, content: "Queued" });
    ownInbox.items.push({ mode: "followUp", id: submission.id, content: "Queued" });
  }, context);
  await expect(importDurableSideChatHistory(f.root, input())).rejects.toThrow(
    "both chats to be idle",
  );
  await expect(exportDurableSideChatHistory(side, "busy-source", inherited.id)).rejects.toThrow(
    "both chats to be idle",
  );
});

it("rejects import and export during a live model run", async () => {
  const f = await fixture();
  const prefix = await f.append("Existing history");
  const stream = createAssistantMessageEventStream();
  let onStart = () => {};
  const started = new Promise<void>((resolve) => {
    onStart = resolve;
  });
  vi.spyOn(f.models.models, "streamSimple").mockImplementation(() => {
    onStart();
    return stream;
  });
  const submission = await f.root.submit({ type: "input", content: "Live request" }, context);
  await started;
  await expect(importDurableSideChatHistory(f.root, input())).rejects.toThrow(
    "both chats to be idle",
  );
  await expect(exportDurableSideChatHistory(f.root, "live-source", prefix.id)).rejects.toThrow(
    "both chats to be idle",
  );
  stream.push({ type: "done", reason: "stop", message: durableAnswer("Finished live request") });
  await submission.wait(context);
});

it("projects attributed original roles, timestamps, references and images as one import group", async () => {
  const f = await fixture();
  const attachment: Attachment = {
    kind: "input",
    id: "00000000-0000-4000-8000-000000000001",
    name: "notes.txt",
    mimeType: "text/plain",
    byteLength: 5,
  };
  const history = input();
  const withAttachments = {
    ...history,
    inputReferenceIds: ["input-id"],
    messages: [
      {
        ...history.messages[0]!,
        attachments: [attachment],
        content: [
          ...history.messages[0]!.content,
          { type: "image" as const, data: "IMAGE_BYTES", mimeType: "image/png" },
        ],
      },
      history.messages[1]!,
    ],
  };
  await importDurableSideChatHistory(f.root, withAttachments);
  const page = await readDurableOriginalPage(f.root);
  const dialogue = page.parts.filter((part) => part.kind === "text");
  expect(dialogue.map((part) => (part.kind === "text" ? part.role : ""))).toEqual([
    "user",
    "assistant",
  ]);
  expect(new Set(page.parts.map((part) => part.sideChatImport?.groupId)).size).toBe(1);
  expect(
    page.parts.every((part) => part.sideChatImport?.sourceSessionId === history.sourceSessionId),
  ).toBe(true);
  expect(dialogue[0]?.sideChatImport?.sourceTimestamp).toBe(123);
  expect(
    page.parts.some(
      (part) =>
        part.kind === "attachment" &&
        part.attachmentKind === "image" &&
        part.data === "IMAGE_BYTES",
    ),
  ).toBe(true);
  expect(JSON.stringify(page.parts)).toContain(attachment.id);
});

it("keeps imported dialogue recallable through OptMem Zoom, archive search/read and exact message refs", async () => {
  const f = await fixture();
  const history = input();
  await importDurableSideChatHistory(f.root, history);
  const memory = createDurableChatMemory(f.harness, f.root, f.storage, {
    budget: () => 4_000,
    summarize: async () => "historical side-chat decision",
  });
  const signal = new AbortController().signal;
  expect((await memory.synchronize(signal)).sourceCount).toBe(1);
  const zoom = await memory.zoom(0, 1, signal);
  expect(zoom.text).toContain('Literal "quotes" and C:\\source.');
  expect(zoom.text).toContain("historical assistant");
  const tools = createDurableArchiveRecallTools({ sessionId: "parent-chat", storage: f.storage });
  const api = { conversationId: f.root.id } as Parameters<(typeof tools)[0]["execute"]>[1];
  const search = await tools[0].execute(
    { query: "Original response", role: "assistant" },
    api,
    context,
  );
  const found = JSON.parse(
    search.output!.map((block) => (block.type === "text" ? block.text : "")).join(""),
  );
  expect(found.matches).toHaveLength(1);
  const entryId = found.matches[0].entryId;
  const read = await tools[1].execute({ entryId, maxChars: 8_000 }, api, context);
  expect(
    JSON.parse(read.output!.map((block) => (block.type === "text" ? block.text : "")).join(""))
      .text,
  ).toContain('Literal "quotes" and C:\\source.');
  const ref = await readDurableMessageReference(f.root, "parent-chat", {
    entryId: String(entryId),
    maxChars: 8_000,
  });
  expect(ref.text).toContain("source-side-chat");
  expect(ref.text).toContain("Original response, not a new reply.");
  const projected = await readDurableOriginalPage(f.root);
  const importedText = projected.parts.find((part) => part.kind === "text");
  expect(importedText?.entryId).toBe(String(entryId));
  const projectedRef = await readDurableMessageReference(f.root, "parent-chat", {
    entryId: importedText?.entryId,
    maxChars: 8_000,
  });
  expect(projectedRef.text).toContain("Original response, not a new reply.");
});
