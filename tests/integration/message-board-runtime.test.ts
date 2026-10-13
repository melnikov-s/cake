import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CustomMessageEntry,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import * as boards from "../../src/domain/artifacts/messageBoards";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { makeMessageBoardStorageLive } from "../../src/services/storage/MessageBoardStorageLive";
import { MessageBoardStorage } from "../../src/services/storage/MessageBoardStorage";
import {
  makeSessionFamilyStorageLive,
  SessionFamilyStorage,
} from "../../src/services/storage/SessionFamilyStorage";
import { CakeOperationRegistry } from "../../src/services/pi/runtime/cake-operation-registry";
import { createMessageBoardOperations } from "../../src/domain/artifacts/cake-message-board-operations";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Message,
} from "@earendil-works/pi-ai";
import {
  createMessageBoardExtension,
  MESSAGE_BOARD_REMINDER,
  observeMessageBoardRequests,
} from "../../src/services/pi/runtime/message-board-extension";
import type { MessageBoardControl } from "../../src/contracts/artifacts/message-board-control";
import {
  boardDescription,
  type BoardEntry,
  type BoardReceipt,
} from "../../src/contracts/artifacts/message-board";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const entry = (sequence: number): BoardEntry => ({
  sequence,
  authorSessionId: "parent",
  createdAt: "2026-01-01T00:00:00Z",
  audience: "workgroup",
  description: `Finding ${sequence}`,
  body: `Full evidence ${sequence}`,
});
function gate() {
  let resolve: () => void = () => {
    throw new Error("Gate not initialized");
  };
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const harness = async (
  input: {
    tools?: number;
    readBody?: boolean;
    nestedRead?: boolean;
    after?: InlineExtension;
    before?: InlineExtension;
    terminate?: boolean;
    persisted?: { cwd: string; control: MessageBoardControl; sessionFile?: string };
  } = {},
) => {
  const cwd = input.persisted?.cwd ?? (await mkdtemp(join(tmpdir(), "cake-board-runtime-")));
  if (!input.persisted) directories.push(cwd);
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir, { recursive: true });
  let boardId = "family-board-test";
  const entries: BoardEntry[] = [];
  const receipts: BoardReceipt[] = [];
  const requests: Message[][] = [];
  const started = [gate(), gate()];
  const released = [gate(), gate()];
  const control: MessageBoardControl = input.persisted?.control ?? {
    append: async (input) => {
      const value: BoardEntry = {
        ...entry(entries.length + 1),
        ...input,
        audience: input.audience,
      };
      entries.push(value);
      return { boardId, entry: boardDescription(value) };
    },
    readNew: async (page, notificationOnly, excluded = []) => {
      const available = entries.filter((entry) => {
        const receipt = receipts.find((value) => value.sequence === entry.sequence);
        return (
          !excluded.some(
            (exclusion) => exclusion.boardId === boardId && exclusion.sequence === entry.sequence,
          ) &&
          !receipt?.readAt &&
          (!notificationOnly || !receipt?.notifiedAt) &&
          entry.sequence > (page.after ?? 0)
        );
      });
      const selected = available.slice(0, page.limit ?? 20).map(boardDescription);
      return {
        boardId,
        entries: selected,
        nextAfter: selected.at(-1)?.sequence ?? 0,
        hasMore: selected.length < available.length,
      };
    },
    current: async () => ({
      boardId,
      entries: entries.map(boardDescription),
      nextAfter: entries.at(-1)?.sequence ?? 0,
      hasMore: false,
    }),
    read: async (sequences) => ({
      boardId,
      entries: entries.filter((entry) => sequences.includes(entry.sequence)),
    }),
    entryReceipts: async () => {
      throw new Error("Unused receipts");
    },
    sessionReceipts: async () => {
      throw new Error("Unused receipts");
    },
    recordIntake: async (id, sequences, kind) => {
      if (id !== boardId) throw new Error("Cannot record another family's board intake");
      for (const sequence of sequences) {
        let value = receipts.find((receipt) => receipt.sequence === sequence);
        if (!value) {
          value = { sequence, sessionId: "child" };
          receipts.push(value);
        }
        if (!value[kind]) Object.assign(value, { [kind]: "2026-01-01T00:01:00Z" });
      }
    },
  };
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models.json"),
    refreshOnCreate: false,
  });
  runtime.registerProvider("board-fixture", {
    api: "openai-responses",
    baseUrl: "https://board-fixture.invalid",
    apiKey: "fixture",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context) {
      requests.push(structuredClone(context.messages));
      const stream = createAssistantMessageEventStream();
      const content: AssistantMessage["content"] =
        requests.length === 1 && (input.tools || input.readBody)
          ? Array.from({ length: input.readBody ? 1 : (input.tools ?? 0) }, (_, index) => ({
              type: "toolCall",
              id: `held-${index}`,
              name: input.nestedRead ? "nested_read" : input.readBody ? "read_body" : "held",
              arguments: { index },
            }))
          : [{ type: "text", text: "Done" }];
      const reason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
      const message: AssistantMessage = {
        role: "assistant",
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: reason,
        timestamp: 1,
      };
      queueMicrotask(() => {
        stream.push({ type: "done", reason, message });
        stream.end();
      });
      return stream;
    },
  });
  const model = runtime.getModel("board-fixture", "fixture");
  if (!model) throw new Error("Missing fixture model");
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    cacheWarming: "off",
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      ...(input.before ? [input.before] : []),
      createMessageBoardExtension(control),
      ...(input.after ? [input.after] : []),
    ],
  });
  await loader.reload();
  const manager = input.persisted
    ? input.persisted.sessionFile
      ? SessionManager.open(input.persisted.sessionFile)
      : SessionManager.create(cwd, join(cwd, "sessions"))
    : SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: manager,
    settingsManager: settings,
    modelRuntime: runtime,
    model,
    resourceLoader: loader,
    noTools: "builtin",
    customTools:
      input.tools || input.readBody
        ? [
            {
              name: "held",
              label: "Held",
              description: "A deterministically held tool",
              parameters: Type.Object({ index: Type.Number() }),
              async execute(_id, value) {
                const { index } = Schema.decodeUnknownSync(Schema.Struct({ index: Schema.Number }))(
                  value,
                );
                started[index]?.resolve();
                await released[index]?.promise;
                return {
                  content: [{ type: "text", text: "Released" }],
                  details: undefined,
                  terminate: input.terminate ?? false,
                };
              },
            },
            {
              name: "nested_read",
              label: "Nested read",
              description: "Consume a board body in a script-like tool caller",
              parameters: Type.Object({}),
              async execute(_id, _value, signal, _update, ctx) {
                await ctx.executeTool("read_body", {}, { signal });
                return {
                  content: [{ type: "text", text: "Processed the finding" }],
                  details: undefined,
                };
              },
            },
            {
              name: "read_body",
              label: "Read body",
              description: "Read a board body",
              parameters: Type.Object({}),
              async execute(toolCallId, _input, signal) {
                if (!input.persisted && !entries.length) entries.push(entry(1));
                const registry = new CakeOperationRegistry(createMessageBoardOperations(control));
                const { content, details } = await registry.invoke(
                  { command: "boards.read", input: { sequences: [1] } },
                  {
                    toolCallId,
                    signal: signal ?? new AbortController().signal,
                    runtime: {},
                  },
                );
                return { content, details };
              },
            },
          ]
        : [],
  });
  observeMessageBoardRequests(session, control);
  await session.bindExtensions({});
  return {
    session,
    manager,
    entries,
    receipts,
    requests,
    started,
    released,
    control,
    setBoardId(id: string) {
      boardId = id;
    },
  };
};

// A fresh Layer graph and ManagedRuntime are acquired on every call. Only disk survives recreation.
const persistedBackend = async (cwd: string) => {
  const artifactRoot = join(cwd, "artifacts");
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeArtifactStorageLive(artifactRoot),
      makeMessageBoardStorageLive(artifactRoot),
      makeSessionFamilyStorageLive(join(cwd, "session-families.json")),
    ).pipe(Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
  );
  const control: MessageBoardControl = {
    append: (input) => runtime.runPromise(boards.append("parent", input)),
    current: (input) => runtime.runPromise(boards.current("child", input)),
    readNew: (input, notificationOnly, excluded) =>
      runtime.runPromise(boards.readNew("child", input, notificationOnly, excluded)),
    read: (sequences) => runtime.runPromise(boards.read("child", sequences)),
    entryReceipts: (sequence) => runtime.runPromise(boards.entryReceipts("child", sequence)),
    sessionReceipts: (sessionId, input) =>
      runtime.runPromise(boards.sessionReceipts("child", sessionId, input)),
    recordIntake: (boardId, sequences, kind) =>
      runtime.runPromise(boards.recordIntake("child", boardId, sequences, kind)),
  };
  return { runtime, control, storage: await runtime.runPromise(MessageBoardStorage) };
};
const seedPersistedBoard = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cake-board-recovery-"));
  directories.push(cwd);
  const backend = await persistedBackend(cwd);
  const board = await backend.runtime.runPromise(
    Effect.gen(function* () {
      const family = yield* (yield* SessionFamilyStorage).addChild({
        familyId: "recovery",
        parentSessionId: "parent",
        parentWorkingDirectory: cwd,
        childSessionId: "child",
        childWorkingDirectory: cwd,
        requestId: "child-request",
        projectPath: cwd,
        createdAt: "2026-01-01T00:00:00Z",
      });
      return yield* boards.ensureBoard(family);
    }),
  );
  return { cwd, backend, boardId: board.lineageId };
};
const persistedReminders = (manager: SessionManager) =>
  manager
    .getBranch()
    .filter(
      (entry): entry is CustomMessageEntry =>
        entry.type === "custom_message" && entry.customType === MESSAGE_BOARD_REMINDER,
    );
const persistedSessionFile = (manager: SessionManager) => {
  const file = manager.getSessionFile();
  if (!file) throw new Error("Expected a disk-backed Pi session");
  return file;
};

describe("message-board intake in real Pi", () => {
  it("delivers coalesced descriptions only after the full parallel tool batch, without queues or extra turns", async () => {
    const fixture = await harness({ tools: 2 });
    try {
      const queued: string[] = [];
      fixture.session.subscribe((event) => {
        if (event.type === "queue_update") queued.push(event.type);
      });
      const prompt = fixture.session.prompt("Work independently");
      await Promise.all(fixture.started.map((gate) => gate.promise));
      await fixture.control.append({
        audience: "workgroup",
        description: "Finding 1",
        body: "Full evidence 1",
      });
      await fixture.control.append({
        audience: "workgroup",
        description: "Finding 2",
        body: "Full evidence 2",
      });
      expect(fixture.receipts).toEqual([]);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.session.isStreaming).toBe(true);
      expect(fixture.session.getSteeringMessages()).toEqual([]);
      expect(fixture.session.getFollowUpMessages()).toEqual([]);
      fixture.released[0]?.resolve();
      expect(fixture.requests).toHaveLength(1);
      fixture.released[1]?.resolve();
      await prompt;
      expect(fixture.requests).toHaveLength(2);
      expect(JSON.stringify(fixture.requests[1])).toContain("Finding 1");
      expect(JSON.stringify(fixture.requests[1])).toContain("Finding 2");
      expect(JSON.stringify(fixture.requests[1])).not.toContain("Full evidence");
      expect(fixture.receipts).toEqual([
        { sequence: 1, sessionId: "child", notifiedAt: expect.any(String) },
        { sequence: 2, sessionId: "child", notifiedAt: expect.any(String) },
      ]);
      expect(queued).toEqual([]);
      const notices = fixture.manager
        .getBranch()
        .filter(
          (entry) => entry.type === "custom_message" && entry.customType === MESSAGE_BOARD_REMINDER,
        );
      expect(notices).toHaveLength(1);
      await fixture.session.prompt("Continue");
      expect(
        fixture.manager
          .getBranch()
          .filter(
            (entry) =>
              entry.type === "custom_message" && entry.customType === MESSAGE_BOARD_REMINDER,
          ),
      ).toHaveLength(1);
    } finally {
      fixture.session.dispose();
    }
  });
  it("persists after a terminated tool batch but stamps notification only on the next genuine request", async () => {
    const fixture = await harness({ tools: 1, terminate: true });
    try {
      const prompt = fixture.session.prompt("Work");
      await fixture.started[0]?.promise;
      fixture.entries.push(entry(1));
      fixture.released[0]?.resolve();
      await prompt;
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.receipts).toEqual([]);
      expect(
        fixture.manager.getBranch().filter((entry) => entry.type === "custom_message"),
      ).toHaveLength(1);
      await fixture.session.prompt("Resume");
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.receipts[0]?.notifiedAt).toEqual(expect.any(String));
      expect(
        fixture.manager.getBranch().filter((entry) => entry.type === "custom_message"),
      ).toHaveLength(1);
    } finally {
      fixture.session.dispose();
    }
  });
  it("defers notification after an abort until the next genuine model request", async () => {
    const fixture = await harness({ tools: 1 });
    try {
      const prompt = fixture.session.prompt("Work");
      await fixture.started[0]?.promise;
      fixture.entries.push(entry(1));
      const aborted = fixture.session.abort();
      fixture.released[0]?.resolve();
      await Promise.all([prompt, aborted]);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.receipts).toEqual([]);
      await fixture.session.prompt("Resume after abort");
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.receipts).toEqual([
        { sequence: 1, sessionId: "child", notifiedAt: expect.any(String) },
      ]);
    } finally {
      fixture.session.dispose();
    }
  });
  it("bounds backlog notices and drains them across genuine requests without follow-up turns", async () => {
    const fixture = await harness({ tools: 1 });
    try {
      const prompt = fixture.session.prompt("Work");
      await fixture.started[0]?.promise;
      fixture.entries.push(...Array.from({ length: 25 }, (_, index) => entry(index + 1)));
      fixture.released[0]?.resolve();
      await prompt;
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.receipts.filter((receipt) => receipt.notifiedAt)).toHaveLength(10);
      expect(JSON.stringify(fixture.requests[1])).not.toContain("Finding 11");
      await fixture.session.prompt("Continue");
      expect(fixture.requests).toHaveLength(3);
      expect(fixture.receipts.filter((receipt) => receipt.notifiedAt)).toHaveLength(25);
      await fixture.session.prompt("Continue again");
      expect(fixture.requests).toHaveLength(4);
      expect(fixture.receipts.filter((receipt) => receipt.notifiedAt)).toHaveLength(25);
      const notices = persistedReminders(fixture.manager);
      const batches = notices.map((notice) =>
        Schema.decodeUnknownSync(
          Schema.Struct({ entries: Schema.Array(Schema.Struct({ sequence: Schema.Number })) }),
        )(notice.details).entries.map((entry) => entry.sequence),
      );
      expect(batches.map((batch) => batch.length)).toEqual([10, 10, 5]);
      expect(batches.flat()).toEqual(Array.from({ length: 25 }, (_, index) => index + 1));
      expect(fixture.receipts.map((receipt) => receipt.sequence)).toEqual(batches.flat());
      expect(fixture.session.getSteeringMessages()).toEqual([]);
      expect(fixture.session.getFollowUpMessages()).toEqual([]);
    } finally {
      fixture.session.dispose();
    }
  });
  it("reconstructs pending notices from effective Pi context after an omission", async () => {
    const fixture = await harness({ tools: 1, terminate: true });
    try {
      const prompt = fixture.session.prompt("Work");
      await fixture.started[0]?.promise;
      fixture.entries.push(entry(1));
      fixture.released[0]?.resolve();
      await prompt;
      const pending = fixture.manager.getBranch().find((entry) => entry.type === "custom_message");
      if (!pending) throw new Error("Expected a pending persisted reminder");
      fixture.manager.appendContextEdit(pending.id, null);
      await fixture.session.prompt("Resume after context cleanup");
      expect(JSON.stringify(fixture.requests[1])).toContain("Finding 1");
      expect(fixture.receipts.filter((receipt) => receipt.notifiedAt)).toHaveLength(1);
    } finally {
      fixture.session.dispose();
    }
  });
  it("does not report descriptions removed by a request context transform as notified", async () => {
    const fixture = await harness({
      tools: 1,
      before: (pi) => {
        pi.on("context", (event) => ({
          messages: event.messages.filter(
            (message) => message.role !== "custom" || message.customType !== MESSAGE_BOARD_REMINDER,
          ),
        }));
      },
    });
    try {
      const prompt = fixture.session.prompt("Work");
      await fixture.started[0]?.promise;
      fixture.entries.push(entry(1));
      fixture.released[0]?.resolve();
      await prompt;
      expect(fixture.requests).toHaveLength(2);
      expect(JSON.stringify(fixture.requests[1])).not.toContain("Finding 1");
      expect(fixture.receipts).toEqual([]);
    } finally {
      fixture.session.dispose();
    }
  });
  it("does not stamp notification when a later full-context transform removes the reminder", async () => {
    const fixture = await harness({
      tools: 1,
      after: (pi) => {
        pi.on("context_with_system", (event) => ({
          messages: event.messages.filter(
            (message) => message.role !== "custom" || message.customType !== MESSAGE_BOARD_REMINDER,
          ),
        }));
      },
    });
    try {
      const prompt = fixture.session.prompt("Work");
      await fixture.started[0]?.promise;
      fixture.entries.push(entry(1));
      fixture.released[0]?.resolve();
      await prompt;
      expect(JSON.stringify(fixture.requests[1])).not.toContain("Finding 1");
      expect(fixture.receipts).toEqual([]);
    } finally {
      fixture.session.dispose();
    }
  });
  it("does not stamp bodies replaced by a later tool-result transform as read", async () => {
    const fixture = await harness({
      readBody: true,
      after: (pi) => {
        pi.on("tool_result", (event) =>
          event.toolName === "read_body"
            ? { content: [{ type: "text", text: "Body removed" }] }
            : undefined,
        );
      },
    });
    try {
      await fixture.session.prompt("Read");
      expect(JSON.stringify(fixture.requests[1])).toContain("Body removed");
      const supplied = fixture.requests[1]
        ?.filter((message) => message.role === "toolResult")
        .map((message) => message.content);
      expect(JSON.stringify(supplied)).not.toContain("Full evidence 1");
      expect(fixture.receipts[0]?.readAt).toBeUndefined();
      expect(fixture.receipts[0]?.notifiedAt).toEqual(expect.any(String));
    } finally {
      fixture.session.dispose();
    }
  });
  it("does not let ten staged but transformed-away notices starve a later entry", async () => {
    const fixture = await harness({
      after: (pi) => {
        pi.on("context_with_system", (event) => ({
          messages: event.messages.filter((message) => {
            if (message.role !== "custom" || message.customType !== MESSAGE_BOARD_REMINDER)
              return true;
            return !JSON.stringify(message.content).includes('Finding 1\\"');
          }),
        }));
      },
    });
    try {
      fixture.entries.push(...Array.from({ length: 10 }, (_, index) => entry(index + 1)));
      await fixture.session.prompt("Work");
      expect(fixture.receipts).toEqual([]);
      fixture.entries.push(entry(11));
      await fixture.session.prompt("Continue");
      expect(JSON.stringify(fixture.requests[1])).toContain("Finding 11");
      expect(fixture.receipts).toEqual([
        { sequence: 11, sessionId: "child", notifiedAt: expect.any(String) },
      ]);
    } finally {
      fixture.session.dispose();
    }
  });
  it("stamps supplied bodies independently of notification and suppresses a later unnecessary reminder", async () => {
    const fixture = await harness({ readBody: true });
    try {
      await fixture.session.prompt("Read the shared finding");
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.receipts).toEqual([
        { sequence: 1, sessionId: "child", readAt: expect.any(String) },
      ]);
      expect(
        fixture.manager.getBranch().filter((entry) => entry.type === "custom_message"),
      ).toHaveLength(0);
      expect(JSON.stringify(fixture.requests[1])).toContain("Full evidence 1");
    } finally {
      fixture.session.dispose();
    }
  });
  it("records final nested-tool body delivery, as used by codemode, without requiring the outer tool to echo it", async () => {
    const fixture = await harness({ readBody: true, nestedRead: true });
    try {
      await fixture.session.prompt("Process the finding");
      expect(fixture.receipts).toEqual([
        { sequence: 1, sessionId: "child", readAt: expect.any(String) },
      ]);
      expect(
        fixture.manager.getBranch().filter((entry) => entry.type === "custom_message"),
      ).toHaveLength(0);
      expect(JSON.stringify(fixture.requests[1])).toContain("Processed the finding");
    } finally {
      fixture.session.dispose();
    }
  });
  it("does not let inherited notices or confirmed sequences from another family suppress this board", async () => {
    const fixture = await harness();
    try {
      fixture.entries.push(entry(1));
      await fixture.session.prompt("Original family");
      expect(fixture.receipts).toHaveLength(1);
      fixture.setBoardId("family-board-new");
      fixture.receipts.splice(0);
      // Simulate inherited context with a fresh observer; this does not recreate Pi or storage.
      observeMessageBoardRequests(fixture.session, fixture.control);
      await fixture.session.prompt("New family with inherited history");
      expect(JSON.stringify(fixture.requests[1])).toContain(
        "New Workboard entries (family-board-new)",
      );
      expect(fixture.receipts).toEqual([
        { sequence: 1, sessionId: "child", notifiedAt: expect.any(String) },
      ]);
    } finally {
      fixture.session.dispose();
    }
  });
  it("collects on genuine idle-start without waking the agent on append", async () => {
    const fixture = await harness();
    try {
      await fixture.control.append({
        audience: "workgroup",
        description: "Finding 1",
        body: "Full evidence 1",
      });
      expect(fixture.requests).toHaveLength(0);
      expect(fixture.session.isStreaming).toBe(false);
      expect(fixture.session.getSteeringMessages()).toEqual([]);
      expect(fixture.session.getFollowUpMessages()).toEqual([]);
      await fixture.session.prompt("Start");
      expect(fixture.requests).toHaveLength(1);
      expect(JSON.stringify(fixture.requests[0])).toContain("Finding 1");
      expect(fixture.receipts[0]?.notifiedAt).toEqual(expect.any(String));
    } finally {
      fixture.session.dispose();
    }
  });
});

describe("message-board disk recovery with a recreated Pi session and storage runtime", () => {
  it("reloads entries and independent receipts without staging or stamping duplicate notifications", async () => {
    const seeded = await seedPersistedBoard();
    let backend = seeded.backend;
    await backend.control.append({
      audience: "workgroup",
      description: "Finding 1",
      body: "Full evidence 1",
    });
    await backend.control.append({
      audience: "workgroup",
      description: "Finding 2",
      body: "Full evidence 2",
    });
    let fixture = await harness({
      persisted: { cwd: seeded.cwd, control: backend.control },
      readBody: true,
    });
    try {
      await fixture.session.prompt("Read one of the shared findings");
      const boardId = seeded.boardId;
      const entriesBefore = await backend.runtime.runPromise(backend.storage.entries(boardId));
      const receiptsBefore = await backend.runtime.runPromise(backend.storage.receipts(boardId));
      expect(entriesBefore.map((entry) => entry.body)).toEqual([
        "Full evidence 1",
        "Full evidence 2",
      ]);
      expect(receiptsBefore).toEqual([
        {
          sequence: 1,
          sessionId: "child",
          notifiedAt: expect.any(String),
          readAt: expect.any(String),
        },
        { sequence: 2, sessionId: "child", notifiedAt: expect.any(String) },
      ]);
      const remindersBefore = persistedReminders(fixture.manager);
      expect(remindersBefore).toHaveLength(1);
      const oldSession = fixture.session;
      const oldStorage = backend.storage;
      const sessionId = fixture.manager.getSessionId();
      const sessionFile = persistedSessionFile(fixture.manager);
      fixture.session.dispose();
      await backend.runtime.dispose();

      backend = await persistedBackend(seeded.cwd);
      fixture = await harness({
        persisted: { cwd: seeded.cwd, control: backend.control, sessionFile },
      });
      expect(fixture.session).not.toBe(oldSession);
      expect(backend.storage).not.toBe(oldStorage);
      expect(fixture.manager.getSessionId()).toBe(sessionId);
      expect(await backend.runtime.runPromise(backend.storage.entries(boardId))).toEqual(
        entriesBefore,
      );
      expect(await backend.runtime.runPromise(backend.storage.receipts(boardId))).toEqual(
        receiptsBefore,
      );
      expect(persistedReminders(fixture.manager)).toEqual(remindersBefore);
      expect(
        (await backend.runtime.runPromise(boards.readNew("child", {}))).entries.map(
          (entry) => entry.sequence,
        ),
      ).toEqual([2]);
      expect((await backend.runtime.runPromise(boards.readNew("child", {}, true))).entries).toEqual(
        [],
      );
      expect(fixture.requests).toEqual([]);

      await fixture.session.prompt("Continue after recreation");
      expect(fixture.requests).toHaveLength(1);
      expect(persistedReminders(fixture.manager)).toEqual(remindersBefore);
      expect(await backend.runtime.runPromise(backend.storage.receipts(boardId))).toEqual(
        receiptsBefore,
      );
    } finally {
      fixture.session.dispose();
      await backend.runtime.dispose();
    }
  });

  it("recovers an undelivered description and newly appended idle entry only on the next genuine request", async () => {
    const seeded = await seedPersistedBoard();
    let backend = seeded.backend;
    let fixture = await harness({
      persisted: { cwd: seeded.cwd, control: backend.control },
      tools: 1,
      terminate: true,
    });
    try {
      const queues: string[] = [];
      const unsubscribe = fixture.session.subscribe((event) => {
        if (event.type === "queue_update") queues.push(event.type);
      });
      const prompt = fixture.session.prompt("Work on a held tool");
      await fixture.started[0]?.promise;
      const boardId = seeded.boardId;
      await backend.control.append({
        audience: "workgroup",
        description: "Finding 1",
        body: "Full evidence 1",
      });
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.session.isStreaming).toBe(true);
      expect(fixture.session.getSteeringMessages()).toEqual([]);
      expect(fixture.session.getFollowUpMessages()).toEqual([]);
      expect(await backend.runtime.runPromise(backend.storage.receipts(boardId))).toEqual([]);
      fixture.released[0]?.resolve();
      await prompt;
      expect(queues).toEqual([]);
      unsubscribe();
      expect(fixture.requests).toHaveLength(1);
      expect(await backend.runtime.runPromise(backend.storage.receipts(boardId))).toEqual([]);
      const pendingReminders = persistedReminders(fixture.manager);
      expect(pendingReminders).toHaveLength(1);
      const sessionFile = persistedSessionFile(fixture.manager);
      const oldStorage = backend.storage;
      fixture.session.dispose();
      await backend.runtime.dispose();

      backend = await persistedBackend(seeded.cwd);
      fixture = await harness({
        persisted: { cwd: seeded.cwd, control: backend.control, sessionFile },
      });
      expect(backend.storage).not.toBe(oldStorage);
      expect(persistedReminders(fixture.manager)).toEqual(pendingReminders);
      expect(await backend.runtime.runPromise(backend.storage.receipts(boardId))).toEqual([]);
      await backend.control.append({
        audience: "workgroup",
        description: "Finding 2",
        body: "Full evidence 2",
      });
      expect(fixture.requests).toEqual([]);
      expect(fixture.session.isStreaming).toBe(false);
      expect(fixture.session.getSteeringMessages()).toEqual([]);
      expect(fixture.session.getFollowUpMessages()).toEqual([]);
      expect(persistedReminders(fixture.manager)).toEqual(pendingReminders);
      expect(await backend.runtime.runPromise(backend.storage.receipts(boardId))).toEqual([]);

      await fixture.session.prompt("Resume after recreation");
      expect(fixture.requests).toHaveLength(1);
      const context = JSON.stringify(fixture.requests[0]);
      expect(context.match(/Finding 1/g)).toHaveLength(1);
      expect(context.match(/Finding 2/g)).toHaveLength(1);
      expect(context).not.toContain("Full evidence");
      const deliveredReceipts = await backend.runtime.runPromise(backend.storage.receipts(boardId));
      expect(deliveredReceipts).toEqual([
        { sequence: 1, sessionId: "child", notifiedAt: expect.any(String) },
        { sequence: 2, sessionId: "child", notifiedAt: expect.any(String) },
      ]);
      expect(persistedReminders(fixture.manager)).toHaveLength(2);
      await fixture.session.prompt("Continue once more");
      expect(fixture.requests).toHaveLength(2);
      expect(persistedReminders(fixture.manager)).toHaveLength(2);
      expect(await backend.runtime.runPromise(backend.storage.receipts(boardId))).toEqual(
        deliveredReceipts,
      );
    } finally {
      fixture.session.dispose();
      await backend.runtime.dispose();
    }
  });
});
