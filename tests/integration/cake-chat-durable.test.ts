import { createCoordinatorRuntime } from "../../src/layers/CakeOperations";
import type { CakeSessionRuntimeSetup } from "../../src/services/pi/CakeSessionRuntimes";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { makePiSettingsLive } from "../../src/services/pi/live/PiSettingsLive";
import { CakeSessionRuntimes } from "../../src/services/pi/CakeSessionRuntimes";
import { piSettingsHandlers } from "../../src/ipc/server/PiSettingsHandlers";
import { makeTaskInputStorageLive } from "../../src/services/storage/TaskInputStorageLive";
import { TaskInputStorage } from "../../src/services/storage/TaskInputStorage";
import { Schema } from "effect";
import {
  MessageListResult,
  MessageReadResult,
} from "../../src/contracts/conversations/message-reference";
import { makeAttachmentReferenceControl } from "../../src/domain/conversations/attachmentReferences";
import { prepareTaskInputs } from "../../src/domain/conversations/taskInputs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  type Provider,
  type Context,
} from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import {
  CakeChatDurable,
  makeCakeChatDurableLive,
} from "../../src/services/pi-durable/CakeChatDurable";
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-identity";
import type { CakeSessionRuntime } from "../../src/services/pi/runtime/cake-session-runtime";
import type { ConversationSnapshot } from "../../src/contracts/conversations/session-contract";
import { durableAnswer, durableModel } from "../fixtures/durable-chat";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
const ids = {
  first: "00000000-0000-4000-8000-000000000001",
  second: "00000000-0000-4000-8000-000000000002",
  third: "00000000-0000-4000-8000-000000000003",
};
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cake-durable-live-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const agentDir = join(directory, "agent");
  const sessionDir = join(directory, "global-chat");
  await mkdir(agentDir, { recursive: true });
  const legacy = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache.json"),
  });
  const provider = legacy.getProvider("openai");
  if (!provider) throw new Error("Missing fixture provider");
  const model = { ...durableModel, provider: "openai" };
  const requests: Context[] = [];
  const keys: Array<string | undefined> = [];
  const providerSessions: Array<string | undefined> = [];
  const started = Deferred.makeUnsafe<void>();
  let hold = false;
  const finishes: Array<() => void> = [];
  let answer: (index: number) => ReturnType<typeof durableAnswer> = () => durableAnswer("Done");
  const streamSimple: Provider["streamSimple"] = (selected, request, options) => {
    requests.push(structuredClone(request));
    keys.push(options?.apiKey);
    providerSessions.push(options?.sessionId);
    const stream = createAssistantMessageEventStream();
    const message = {
      ...answer(requests.length),
      api: selected.api,
      provider: selected.provider,
      model: selected.id,
      timestamp: Date.now(),
    };
    const finish = () =>
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
    finishes.push(finish);
    stream.push({ type: "start", partial: message });
    Effect.runSync(Deferred.succeed(started, undefined));
    if (hold)
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
    else queueMicrotask(finish);
    return stream;
  };
  legacy.registerNativeProvider({
    ...provider,
    getModels: () => [model],
    getAllModels: () => [model],
    streamSimple,
    stream: (selected, request, options) =>
      streamSimple(selected, request, { signal: options?.signal, apiKey: options?.apiKey }),
  });
  await legacy.setRuntimeApiKey("openai", "fixture-key");
  vi.spyOn(ModelRuntime, "create").mockResolvedValue(legacy);
  const serviceRuntime = ManagedRuntime.make(makeCakeChatDurableLive(createCoordinatorRuntime));
  cleanup.push(() => serviceRuntime.dispose());
  const service = await serviceRuntime.runPromise(CakeChatDurable);
  const summarize = vi.fn<(input: { signal: AbortSignal }) => Promise<string>>(
    async () => "talk: exact original details remain available through zoom",
  );
  const snapshots: ConversationSnapshot[] = [];
  const watchers = new Set<(snapshot: ConversationSnapshot) => void>();
  const waitSnapshot = async (
    runtime: CakeSessionRuntime,
    predicate: (snapshot: ConversationSnapshot) => boolean,
  ) => {
    const found = Deferred.makeUnsafe<ConversationSnapshot>();
    const listener = (snapshot: ConversationSnapshot) => {
      if (predicate(snapshot)) Effect.runSync(Deferred.succeed(found, snapshot));
    };
    watchers.add(listener);
    try {
      listener(await runtime.snapshot());
      return await Effect.runPromise(Deferred.await(found));
    } finally {
      watchers.delete(listener);
    }
  };
  const open = async (
    globalControl?: CakeSessionRuntimeSetup["globalControl"],
    attachmentReferenceControl?: CakeSessionRuntimeSetup["attachmentReferenceControl"],
  ) => {
    const runtime = await serviceRuntime.runPromise(
      service.createRuntime({
        cwd: directory,
        trusted: true,
        agentDir,
        sessionDir,
        sessionId: CAKE_CHAT_SESSION_ID,
        requestUi: async () => undefined,
        globalControl: globalControl ?? { tools: [], invoke: async () => ({}) },
        attachmentReferenceControl,
        modelPresets: () => ({
          presets: [
            {
              id: ids.first,
              name: "Fixture",
              provider: "openai",
              modelId: "fixture",
              thinkingLevel: "off",
              fastMode: false,
            },
          ],
          defaultPresetId: ids.first,
        }),
        cakeChatMemory: {
          preferences: () => ({
            memoryViewBytes: 4_000,
            instructions: "Coordinate independent Project Sessions",
          }),
          summarize,
        },
        onEvent(event) {
          if (event.type === "snapshot") {
            snapshots.push(event.snapshot);
            for (const listener of watchers) listener(event.snapshot);
          }
        },
      }),
    );
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await runtime.dispose();
      }
    };
    cleanup.push(close);
    return { runtime, close };
  };
  /** Opens a side-chat fork the way a Discussion Session sidecar acquisition does. */
  const openSideChat = async (sessionId: string) => {
    const events: ConversationSnapshot[] = [];
    const runtime = await serviceRuntime.runPromise(
      service.createSideChatRuntime({
        cwd: directory,
        trusted: true,
        agentDir,
        sessionDir: join(directory, "reviews", "side-chat"),
        directSessionDir: true,
        newSession: false,
        sessionId,
        auxiliary: true,
        tools: [],
        requestUi: async () => undefined,
        onEvent(event) {
          if (event.type === "snapshot") events.push(event.snapshot);
        },
      }),
    );
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await runtime.dispose();
      }
    };
    cleanup.push(close);
    return { runtime, close, events };
  };
  return {
    directory,
    agentDir,
    sessionDir,
    service,
    openSideChat,
    serviceRuntime,
    requests,
    keys,
    providerSessions,
    summarize,
    snapshots,
    waitSnapshot,
    started,
    finishes,
    open,
    hold: (value: boolean) => {
      hold = value;
    },
    answer: (value: typeof answer) => {
      answer = value;
    },
  };
}

it("saves and reloads global Pi settings while permanent Cake Chat is busy without losing its turn, queue or history", async () => {
  const f = await fixture();
  const { runtime } = await f.open();
  const settingsRuntime = ManagedRuntime.make(
    Layer.mergeAll(
      makePiSettingsLive(f.agentDir).pipe(
        Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
      ),
      Layer.mock(CakeSessionRuntimes, {
        reloadAll: () => Effect.tryPromise(() => runtime.reload!()),
      }),
    ),
  );
  cleanup.push(() => settingsRuntime.dispose());
  f.hold(true);
  const pending = runtime.prompt("Retain this active turn", "prompt", [], false, ids.first);
  await Effect.runPromise(Deferred.await(f.started));
  const queued = runtime.prompt("Retain this queued input", "follow-up", [], false, ids.second);
  const before = await f.waitSnapshot(runtime, (snapshot) =>
    snapshot.parts.some(
      (part) =>
        part.kind === "text" &&
        part.text === "Retain this queued input" &&
        part.deliveryState === "queued",
    ),
  );
  const updated = await settingsRuntime.runPromise(
    piSettingsHandlers["piSettings.update"]({
      update: { key: "defaultTools", value: ["+codemode"] },
    }),
  );
  expect(updated.defaultTools).toEqual(["+codemode"]);
  await settingsRuntime.runPromise(
    piSettingsHandlers["piSettings.update"]({
      update: { key: "autoCompact", value: false },
    }),
  );
  await settingsRuntime.runPromise(piSettingsHandlers["piSettings.reload"]());
  const after = await runtime.snapshot();
  expect(after.piSettings?.autoCompact).toBe(false);
  expect(after.streaming).toBe(true);
  expect(after.sessionFile).toBe(before.sessionFile);
  expect(after.model).toEqual(before.model);
  expect(after.parts).toEqual(before.parts);
  expect(f.requests).toHaveLength(1);
  f.hold(false);
  f.finishes[0]!();
  await pending;
  await queued;
  const settled = await f.waitSnapshot(
    runtime,
    (snapshot) =>
      !snapshot.streaming &&
      snapshot.parts.some(
        (part) =>
          part.kind === "text" && part.text === "Retain this queued input" && !part.deliveryState,
      ),
  );
  expect(JSON.stringify(settled.parts)).toContain("Retain this active turn");
  expect(f.requests).toHaveLength(2);
});

it("keeps attachment bytes out of provider input, originals, zoom and future memory across compaction and reopen", async () => {
  const f = await fixture();
  const vault = ManagedRuntime.make(makeTaskInputStorageLive(f.directory));
  cleanup.push(() => vault.dispose());
  const secret = "PRIVATE_LOG_SENTINEL " + "exact log text\r\n".repeat(500);
  const data = Buffer.from("PRIVATE_IMAGE_SENTINEL").toString("base64");
  const attachments = [
    { kind: "text" as const, name: "Pasted text", text: secret },
    { kind: "image" as const, name: "screenshot.png", mimeType: "image/png", data },
  ];
  const refs = await vault.runPromise(prepareTaskInputs(CAKE_CHAT_SESSION_ID, true, attachments));
  const first = await f.open();
  await expect(first.runtime.prompt("Research", "prompt", attachments)).rejects.toThrow(
    "references only",
  );
  expect(f.requests).toHaveLength(0);
  await first.runtime.prompt(
    `Research these inputs. ${"Coordinator instruction. ".repeat(300)}`,
    "prompt",
    [...refs],
    false,
    ids.first,
  );
  await first.runtime.compact("Retain task references");
  expect(f.summarize).toHaveBeenCalled();
  await first.close();
  const before = f.requests.length;
  f.answer((index) =>
    index === before + 1
      ? durableAnswer("", [
          { type: "toolCall", id: "zoom-input", name: "zoom", arguments: { id: 1, n: 1 } },
        ])
      : durableAnswer("Done"),
  );
  const reopened = await f.open();
  await reopened.runtime.prompt("Continue coordination", "prompt", [], false, ids.second);
  // zoom reads the exact original, not merely the currently compacted provider view.
  const history = await reopened.runtime.snapshot();
  expect(f.requests.length).toBeGreaterThanOrEqual(before + 2);
  expect(JSON.stringify(f.requests)).toContain("zoom-input");
  const combined = JSON.stringify([f.requests, f.summarize.mock.calls, history]);
  for (const payload of ["PRIVATE_LOG_SENTINEL", "PRIVATE_IMAGE_SENTINEL", secret, data])
    expect(combined).not.toContain(payload);
  expect(JSON.stringify(history.parts)).toContain("Pasted text");
  const storage = await vault.runPromise(TaskInputStorage);
  const selected = refs.flatMap((ref) => (ref.kind === "input" ? [ref.id] : []));
  const grants = await vault.runPromise(
    storage.authorizeForward(CAKE_CHAT_SESSION_ID, selected, ids.third),
  );
  const delivered = await vault.runPromise(
    prepareTaskInputs(
      ids.third,
      false,
      grants.map((reference) => ({ kind: "forwarded-input", name: "Attachment", reference })),
    ),
  );
  const [file, image] = delivered;
  if (file?.kind !== "file") throw new Error("Expected log file");
  expect(await readFile(file.path, "utf8")).toBe(secret);
  expect(image).toMatchObject({
    kind: "image",
    name: "screenshot.png",
    mimeType: "image/png",
    data,
  });
  if (image?.kind !== "image" || !image.originalPath)
    throw new Error("Expected original image file");
  expect((await readFile(image.originalPath)).toString("base64")).toBe(data);
});

it("explicitly inspects a historical screenshot as provider image pixels after compaction and reopen", async () => {
  const f = await fixture();
  const vault = ManagedRuntime.make(makeTaskInputStorageLive(f.directory));
  cleanup.push(() => vault.dispose());
  const data =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
  const refs = await vault.runPromise(
    prepareTaskInputs(CAKE_CHAT_SESSION_ID, true, [
      { kind: "image", name: "historical.png", mimeType: "image/png", data },
    ]),
  );
  const ref = refs[0];
  if (ref?.kind !== "input") throw new Error("Missing reference");
  const control = makeAttachmentReferenceControl(CAKE_CHAT_SESSION_ID, (effect, options) =>
    vault.runPromise(effect, options),
  );
  const first = await f.open(undefined, control);
  await first.runtime.prompt(`Keep the reference. ${"context ".repeat(700)}`, "prompt", [...refs]);
  await first.runtime.compact("Keep attachment IDs");
  expect(JSON.stringify(f.requests)).not.toContain(data);
  const messages = Schema.decodeUnknownSync(MessageListResult)(
    await first.runtime.inspectSession({ kind: "messages-list", roles: ["user"], limit: 10 }),
  );
  const original = messages.messages.find((message) =>
    message.inputRefs.some((input) => input.id === ref.id),
  );
  if (!original) throw new Error("Missing exact original message reference");
  expect(JSON.stringify(messages)).not.toContain("Keep the reference");
  expect(JSON.stringify(messages)).not.toContain(data);
  await first.close();
  const before = f.requests.length;
  f.answer((index) =>
    index === before + 1
      ? durableAnswer("", [
          {
            type: "toolCall",
            id: "read-exact-image",
            name: "cake",
            arguments: { command: "attachments.read", input: { reference: ref.id } },
          },
        ])
      : durableAnswer("Inspected the screenshot"),
  );
  const reopened = await f.open(undefined, control);
  const exact = Schema.decodeUnknownSync(MessageReadResult)(
    await reopened.runtime.inspectSession({
      kind: "messages-read",
      entryId: original.entryId,
      maxChars: 25,
    }),
  );
  expect(exact.message.ref).toBe(original.ref);
  expect(exact.text).toBe("Keep the reference. context ".slice(0, 25));
  const described = Schema.decodeUnknownSync(MessageListResult)(
    await reopened.runtime.inspectSession({
      kind: "messages-list",
      entryId: original.entryId,
      limit: 1,
    }),
  );
  expect(described.messages).toEqual([original]);
  await expect(
    reopened.runtime.inspectSession({ kind: "messages-read", entryId: "999999999" }),
  ).rejects.toThrow("does not exist");
  await reopened.runtime.prompt("Inspect that earlier screenshot", "prompt", []);
  const toolResults = f.requests
    .slice(before)
    .flatMap((request) => request.messages.filter((message) => message.role === "toolResult"));
  expect(toolResults).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        content: expect.arrayContaining([{ type: "image", mimeType: "image/png", data }]),
      }),
    ]),
  );
  const snapshot = await reopened.runtime.snapshot();
  const inspected = snapshot.parts.find(
    (part) => part.kind === "tool" && part.command === "attachments.read",
  );
  if (inspected?.kind !== "tool") throw new Error("Missing inspection tool result");
  expect(inspected.output).not.toContain(data);
  expect(inspected.outputContent).toContainEqual({ type: "image", mimeType: "image/png", data });
});

it("runs quick bash checks in its scratch directory with bounded, annotated output", async () => {
  const f = await fixture();
  f.answer((index) =>
    index === 1
      ? durableAnswer("", [
          {
            type: "toolCall",
            id: "quick-check",
            name: "bash",
            arguments: { command: "pwd; for i in $(seq 1 2000); do echo line-$i; done" },
          },
        ])
      : durableAnswer("Done"),
  );
  const { runtime } = await f.open();
  await runtime.prompt("Check something quickly", "prompt", [], false, ids.first);
  const result = f.requests[1]?.messages.find((message) => message.role === "toolResult");
  if (result?.role !== "toolResult") throw new Error("Missing bash result");
  const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
  // The tail is kept, so the first line (pwd) is dropped while the newest output survives.
  expect(text).toContain("line-2000");
  expect(text).not.toContain("line-1\n");
  expect(text).toContain("Output truncated to its end");
  f.answer((index) =>
    index === 3
      ? durableAnswer("", [
          { type: "toolCall", id: "where", name: "bash", arguments: { command: "pwd" } },
        ])
      : durableAnswer("Done"),
  );
  await runtime.prompt("Where are you?", "prompt", [], false, ids.second);
  const where = f.requests[3]?.messages.findLast((message) => message.role === "toolResult");
  expect(JSON.stringify(where)).toContain(join(f.sessionDir, "scratch"));
});

it("uses production SQLite, existing credentials and exact originals across reopen", async () => {
  const f = await fixture();
  const original = `ANCIENT_DETAIL ${"original words ".repeat(200)}`;
  f.answer(() => durableAnswer(original));
  const first = await f.open();
  await first.runtime.prompt("Remember this", "prompt", [], true, ids.first);
  expect(f.keys).toEqual(["fixture-key"]);
  expect(JSON.stringify(f.requests[0])).not.toContain("cake-input-presentation");
  const offered = f.requests[0]?.messages.flatMap((message) =>
    message.role === "system" ? (message.toolsAdded?.map((tool) => tool.name) ?? []) : [],
  );
  expect(offered).toEqual(["cake", "zoom", "date", "read", "bash", "mcp"]);
  expect(
    (await first.runtime.snapshot()).parts.some(
      (part) => part.kind === "text" && part.role === "user" && part.renderAs === "markdown",
    ),
  ).toBe(true);
  await first.close();
  const before = f.requests.length;
  await f.serviceRuntime.runPromise(f.service.catalogEntry(f.sessionDir));
  const preview = await f.serviceRuntime.runPromise(
    f.service.inspect(f.sessionDir, CAKE_CHAT_SESSION_ID),
  );
  expect(JSON.stringify(preview.parts)).toContain(original);
  expect(f.requests).toHaveLength(before);
  f.answer((index) =>
    index === before + 1
      ? durableAnswer("", [
          { type: "toolCall", id: "zoom-original", name: "zoom", arguments: { id: 1, n: 1 } },
        ])
      : durableAnswer("Done"),
  );
  const second = await f.open();
  await second.runtime.prompt("Remember this", "prompt", [], true, ids.first);
  expect(f.requests).toHaveLength(before);
  await second.runtime.prompt("Open the exact original", "prompt", [], false, ids.second);
  expect(JSON.stringify(f.requests[before])).not.toContain(original);
  expect(JSON.stringify(f.requests[before + 1])).toContain(original);
  const snapshot = await second.runtime.snapshot();
  expect(snapshot.sessionFile).toMatch(/coordinator\.sqlite$/);
  expect(
    snapshot.parts.filter((part) => part.kind === "text" && part.role === "user"),
  ).toHaveLength(2);
});

it("Stop preserves the inbox; send-now retains reference-only attachments and Markdown without image payloads", async () => {
  const f = await fixture();
  f.hold(true);
  const { runtime } = await f.open();
  const active = runtime
    .prompt("Hold", "prompt", [], false, ids.first)
    .catch((error: unknown) => error);
  await Effect.runPromise(Deferred.await(f.started));
  const one = runtime
    .prompt("One", "follow-up", [], false, ids.second)
    .catch((error: unknown) => error);
  const two = runtime
    .prompt(
      "Two",
      "follow-up",
      [{ kind: "input", id: ids.first, name: "sample.png", mimeType: "image/png", byteLength: 6 }],
      true,
      ids.third,
    )
    .catch((error: unknown) => error);
  await f.waitSnapshot(
    runtime,
    (snapshot) =>
      snapshot.parts.filter((part) => part.kind === "text" && part.queuedInput).length === 2,
  );
  await runtime.reorderPendingMessage({ itemId: ids.second, position: 2 });
  expect((await runtime.pendingMessages()).items.map((item) => item.itemId)).toEqual([
    ids.third,
    ids.second,
  ]);
  await runtime.abort();
  expect(await active).toBeInstanceOf(Error);
  expect((await runtime.pendingMessages()).items).toHaveLength(2);
  const held = (await runtime.snapshot()).parts.find(
    (part) => part.kind === "text" && part.queuedInput?.itemId === ids.third,
  );
  expect(held).toMatchObject({
    queuedInput: {
      text: "Two",
      renderUserMessageAsMarkdown: true,
      attachments: [{ kind: "input", name: "sample.png", id: ids.first }],
    },
  });
  f.hold(false);
  await runtime.sendQueuedMessageNow(`queued-${ids.third}`);
  expect(await two).toBeUndefined();
  expect(await one).toBeUndefined();
  const snapshot = await runtime.snapshot();
  expect(
    snapshot.parts
      .filter((part) => part.kind === "text" && part.role === "user")
      .map((part) => (part.kind === "text" ? part.text : "")),
  ).toEqual(["Hold", "Two", "One"]);
  expect(JSON.stringify(f.requests[1])).not.toContain("c2FtcGxl");
  expect(JSON.stringify(f.requests[1])).toContain(ids.first);
});

it("restart resumes a placed run and a queued worker report without resubmission or duplicate originals", async () => {
  const f = await fixture();
  f.hold(true);
  const first = await f.open();
  const active = first.runtime
    .prompt("Continue after restart", "prompt", [], false, ids.first)
    .catch((error: unknown) => error);
  await Effect.runPromise(Deferred.await(f.started));
  const report = first.runtime.notifySubagentCompletion!({
    handleId: ids.third,
    task: "Review project",
    status: "complete",
    resolvedModel: {
      requested: "utility",
      source: "utility",
      provider: "openai",
      modelId: "fixture",
      thinkingLevel: "off",
      fallbacks: [],
    },
    fastMode: false,
    streaming: false,
    parts: [
      {
        id: "worker-result",
        kind: "text",
        role: "assistant",
        status: "complete",
        text: "WORKER_RESULT",
      },
    ],
    usage: { cost: 0.25 },
  }).catch((error: unknown) => error);
  await f.waitSnapshot(first.runtime, (snapshot) =>
    snapshot.parts.some(
      (part) => part.kind === "text" && part.queuedInput && part.text.includes("WORKER_RESULT"),
    ),
  );
  const queuedReport = (await first.runtime.snapshot()).parts.find(
    (part) => part.kind === "text" && part.subagentReport?.handleId === ids.third,
  );
  expect(queuedReport).toMatchObject({
    subagentReport: { handleId: ids.third, task: "Review project", status: "complete" },
    deliveryState: "queued",
  });
  await first.close();
  await active;
  await report;
  const requests = f.requests.length;
  await f.serviceRuntime.runPromise(f.service.inspect(f.sessionDir, CAKE_CHAT_SESSION_ID));
  expect(f.requests).toHaveLength(requests);
  f.hold(false);
  const second = await f.open();
  const settled = await f.waitSnapshot(
    second.runtime,
    (snapshot) =>
      !snapshot.streaming &&
      snapshot.parts.some(
        (part) => part.kind === "text" && part.subagentReport?.handleId === ids.third,
      ),
  );
  expect(settled.parts.filter((part) => part.kind === "text" && part.role === "user")).toHaveLength(
    2,
  );
  expect(
    settled.parts.filter(
      (part) => part.kind === "text" && part.subagentReport?.handleId === ids.third,
    ),
  ).toHaveLength(1);
  expect(settled.parts.find((part) => part.kind === "text" && part.subagentReport)?.kind).toBe(
    "text",
  );
  expect(JSON.stringify(f.requests.at(-1))).toContain("WORKER_RESULT");
  expect(JSON.stringify(f.requests.at(-1))).toContain(ids.third);
  const reportText = f.requests
    .at(-1)
    ?.messages.flatMap((message) =>
      message.role === "user"
        ? typeof message.content === "string"
          ? [message.content]
          : message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
        : [],
    )
    .join("\n");
  expect(reportText).toContain('"cost":0.25');
});

it("cancels only queued inputs and steering continues the existing run without a fresh memory reset", async () => {
  const f = await fixture();
  f.hold(true);
  const { runtime } = await f.open();
  const active = runtime.prompt("Original question", "prompt", [], false, ids.first);
  await Effect.runPromise(Deferred.await(f.started));
  const cancelled = runtime
    .prompt("Cancel this", "follow-up", [], false, ids.second)
    .catch((error: unknown) => error);
  const redirect = runtime.prompt("Redirect this run", "follow-up", [], false, ids.third);
  await f.waitSnapshot(
    runtime,
    (snapshot) =>
      snapshot.parts.filter((part) => part.kind === "text" && part.queuedInput).length === 2,
  );
  await runtime.removeQueuedMessage(`queued-${ids.second}`);
  expect(await cancelled).toBeInstanceOf(Error);
  await runtime.steerQueuedMessage(`queued-${ids.third}`);
  f.hold(false);
  f.finishes[0]!();
  await active;
  await redirect;
  const text = JSON.stringify(f.requests[1]);
  expect(text).toContain("Original question");
  expect(text).toContain("Redirect this run");
  expect(text).toContain("<chat>\\n\\n</chat>");
  expect(text).not.toContain("user: Original question");
  await expect(runtime.removeQueuedMessage(`queued-${ids.third}`)).rejects.toThrow();
});

it("closing during slow summarization preserves the accepted request checkpoint for restart", async () => {
  const f = await fixture();
  const summaryStarted = Deferred.makeUnsafe<void>();
  const blocked = Deferred.makeUnsafe<string>();
  f.summarize.mockImplementation(({ signal }) => {
    Effect.runSync(Deferred.succeed(summaryStarted, undefined));
    return Effect.runPromise(Deferred.await(blocked), { signal });
  });
  const first = await f.open();
  await first.runtime.prompt("LARGE_ORIGINAL ".repeat(100), "prompt", [], false, ids.first);
  await Effect.runPromise(Deferred.await(summaryStarted));
  const pending = first.runtime
    .prompt("Accepted before slow preparation", "prompt", [], false, ids.second)
    .catch((error: unknown) => error);
  await f.waitSnapshot(first.runtime, (snapshot) =>
    snapshot.parts.some(
      (part) => part.kind === "text" && part.text === "Accepted before slow preparation",
    ),
  );
  await first.close();
  await pending;
  f.summarize.mockResolvedValue("user: large original retained; zoom for exact detail");
  const second = await f.open();
  const settled = await f.waitSnapshot(
    second.runtime,
    (snapshot) =>
      !snapshot.streaming &&
      snapshot.parts.filter((part) => part.kind === "text" && part.role === "assistant").length ===
        2,
  );
  expect(
    settled.parts.filter(
      (part) => part.kind === "text" && part.text === "Accepted before slow preparation",
    ),
  ).toHaveLength(1);
  expect(f.requests).toHaveLength(2);
});

it("does not replay a session-creation mutation interrupted after its external side effect", async () => {
  const f = await fixture();
  const invoked = Deferred.makeUnsafe<void>();
  const blocked = Deferred.makeUnsafe<never>();
  const invoke = vi.fn<NonNullable<CakeSessionRuntimeSetup["globalControl"]>["invoke"]>(
    (_input, signal) => {
      // The worker exists externally, but its tool result has not reached SQLite yet.
      Effect.runSync(Deferred.succeed(invoked, undefined));
      return Effect.runPromise(Deferred.await(blocked), { signal });
    },
  );
  const control: NonNullable<CakeSessionRuntimeSetup["globalControl"]> = {
    tools: [
      {
        command: "sessions.create",
        topic: "sessions",
        summary: "Create a Project Session",
        parameters: {
          type: "object",
          properties: {
            projectPath: { type: "string" },
            name: { type: "string" },
            initialPrompt: { type: "string" },
          },
          required: ["projectPath", "name", "initialPrompt"],
          additionalProperties: false,
        },
      },
    ],
    invoke,
  };
  f.answer((index) =>
    index === 1
      ? durableAnswer("", [
          {
            type: "toolCall",
            id: "spawn-once",
            name: "cake",
            arguments: {
              command: "sessions.create",
              input: { projectPath: "/project", name: "Worker", initialPrompt: "Execute the task" },
            },
          },
        ])
      : durableAnswer("Recovered without respawning"),
  );
  const first = await f.open(control);
  const pending = first.runtime
    .prompt("Create one worker", "prompt", [], false, ids.first)
    .catch((error: unknown) => error);
  await Effect.runPromise(Deferred.await(invoked));
  await first.close();
  await pending;
  const second = await f.open(control);
  const snapshot = await f.waitSnapshot(second.runtime, (value) => !value.streaming);
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(
    snapshot.parts.filter((part) => part.kind === "text" && part.text === "Create one worker"),
  ).toHaveLength(1);
});

const textParts = (snapshot: ConversationSnapshot) =>
  snapshot.parts.flatMap((part) =>
    part.kind === "text" ? [{ role: part.role, text: part.text }] : [],
  );
const entryOf = (snapshot: ConversationSnapshot, text: string) => {
  const part = snapshot.parts.find(
    (candidate) => candidate.kind === "text" && candidate.text === text,
  );
  if (part?.kind !== "text" || part.entryId === undefined) throw new Error(`No entry for ${text}`);
  return part.entryId;
};

it("forks a side chat from Cake Chat's exact provider context and leaves Cake Chat untouched", async () => {
  const f = await fixture();
  f.answer((index) =>
    index === 1
      ? durableAnswer("", [
          { type: "toolCall", id: "read-1", name: "read", arguments: { path: "missing.txt" } },
        ])
      : index === 2
        ? durableAnswer("First answer")
        : index === 3
          ? durableAnswer("Second answer")
          : index === 4
            ? durableAnswer("Side answer")
            : durableAnswer("Third answer"),
  );
  const { runtime } = await f.open();
  await runtime.prompt("First question", "prompt", [], false, ids.first);
  await runtime.prompt("Second question", "prompt", [], false, ids.second);
  const before = await runtime.snapshot();
  const summaries = f.summarize.mock.calls.length;

  // Anchored at a user message whose reply needed a tool round: the fork lands on the
  // completed reply, never on a dangling tool call.
  const fork = await runtime.fork(entryOf(before, "First question"), "Side chat");
  expect(fork.sessionId).toMatch(/:side-chat:\d+$/);
  const side = await f.openSideChat(fork.sessionId);
  expect(textParts(await side.runtime.snapshot())).toEqual([]);
  await side.runtime.prompt("Side question", "prompt", [], false, ids.first);

  // The fork's first request extends Cake Chat's last request for that exchange
  // byte-for-byte: same system prompt, offered tools, memory view and tool round.
  const parent = f.requests[1]!;
  const forked = f.requests[3]!;
  expect(forked.systemPrompt).toEqual(parent.systemPrompt);
  expect(forked.tools).toEqual(parent.tools);
  expect(forked.messages.slice(0, parent.messages.length)).toEqual(parent.messages);
  const [reply, question, ...rest] = forked.messages.slice(parent.messages.length);
  expect(rest).toEqual([]);
  expect(reply).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "First answer" }],
  });
  expect(JSON.stringify(question)).toContain("Side question");
  expect(JSON.stringify(question)).toContain("<cake-side-chat>");
  expect(JSON.stringify(forked)).not.toContain("Second question");
  expect(JSON.stringify(forked)).not.toContain("cake-input-presentation");

  // The side chat shows only its own exchange, without the model-only note.
  expect(textParts(await side.runtime.snapshot())).toEqual([
    { role: "user", text: "Side question" },
    { role: "assistant", text: "Side answer" },
  ]);
  const preview = await f.serviceRuntime.runPromise(f.service.inspectSideChat(fork.sessionId));
  expect(preview?.parts.map((part) => part.kind === "text" && part.text)).toEqual([
    "Side question",
    "Side answer",
  ]);

  // Cake Chat's transcript, queue, usage and memory never see the side chat.
  const after = await runtime.snapshot();
  expect(after.parts).toEqual(before.parts);
  expect(after.usage).toEqual(before.usage);
  expect(await runtime.pendingMessages()).toEqual({ items: [] });
  expect(f.summarize.mock.calls.length).toBe(summaries);
  await runtime.prompt("Third question", "prompt", [], false, ids.third);
  const next = JSON.stringify(f.requests[4]);
  expect(next).toContain("Second answer");
  expect(next).not.toContain("Side question");
  expect(next).not.toContain("Side answer");
  expect(next).not.toContain("<cake-side-chat>");
  expect(JSON.stringify(f.summarize.mock.calls)).not.toContain("Side answer");
  expect(textParts(await side.runtime.snapshot())).toHaveLength(2);
});

it("keeps side-chat forks across restart and refuses Cake controls inside them", async () => {
  const f = await fixture();
  const invoke = vi.fn<NonNullable<CakeSessionRuntimeSetup["globalControl"]>["invoke"]>(
    async () => ({ ok: true }),
  );
  f.answer((index) =>
    index === 1
      ? durableAnswer("Parent answer")
      : index === 2
        ? durableAnswer("", [
            {
              type: "toolCall",
              id: "cake-1",
              name: "cake",
              arguments: { command: "sessions.create", input: {} },
            },
          ])
        : durableAnswer(index === 3 ? "Side answer" : "Later side answer"),
  );
  const first = await f.open({ tools: [], invoke });
  await first.runtime.prompt("Parent question", "prompt", [], false, ids.first);
  const parentParts = (await first.runtime.snapshot()).parts;
  const fork = await first.runtime.fork(
    entryOf(await first.runtime.snapshot(), "Parent answer"),
    "Side chat",
  );
  const side = await f.openSideChat(fork.sessionId);
  await side.runtime.prompt("Start a session", "prompt", [], false, ids.first);
  // A reply without tool rounds leaves only Cake Chat's run reset before the fork point;
  // the fork still repeats that request exactly instead of re-sending the system prompt.
  const parent = f.requests[0]!;
  const forked = f.requests[1]!;
  expect(forked.messages.slice(0, parent.messages.length)).toEqual(parent.messages);
  expect(forked.messages.slice(parent.messages.length).map((message) => message.role)).toEqual([
    "assistant",
    "user",
  ]);
  // Session-keyed provider caches see the same identity as Cake Chat.
  expect(f.providerSessions[1]).toBe(f.providerSessions[0]);
  expect(invoke).not.toHaveBeenCalled();
  expect(JSON.stringify(f.requests[2])).toContain("Cake controls are unavailable in side chats");
  await side.close();
  await first.close();

  const second = await f.open({ tools: [], invoke });
  expect((await second.runtime.snapshot()).parts).toEqual(parentParts);
  const reopened = await f.openSideChat(fork.sessionId);
  expect(textParts(await reopened.runtime.snapshot()).filter((part) => part.text !== "")).toEqual([
    { role: "user", text: "Start a session" },
    { role: "assistant", text: "Side answer" },
  ]);
  await reopened.runtime.prompt("Follow up", "prompt", [], false, ids.second);
  const followUp = JSON.stringify(f.requests[3]);
  expect(followUp).toContain("Parent answer");
  expect(followUp).toContain("Side answer");
  // The orientation note is sent once, with the first side-chat input.
  expect(followUp.split("<cake-side-chat>")).toHaveLength(2);
  expect((await second.runtime.snapshot()).parts).toEqual(parentParts);
});

it("rejects side-chat forks from a message without a completed reply", async () => {
  const f = await fixture();
  f.hold(true);
  const { runtime } = await f.open();
  const pending = runtime.prompt("Still running", "prompt", [], false, ids.first);
  await Effect.runPromise(Deferred.await(f.started));
  const snapshot = await f.waitSnapshot(runtime, (value) =>
    value.parts.some(
      (part) => part.kind === "text" && part.text === "Still running" && part.entryId,
    ),
  );
  await expect(runtime.fork(entryOf(snapshot, "Still running"), "Side chat")).rejects.toThrow(
    "has no completed reply",
  );
  await expect(runtime.fork("999999", "Side chat")).rejects.toThrow("no longer available");
  f.hold(false);
  f.finishes[0]!();
  await pending;
});
