import { createCoordinatorRuntime } from "../../src/layers/CakeOperations";
import type { CakeSessionRuntimeSetup } from "../../src/services/pi/CakeSessionRuntimes";
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { makePiSettingsLive } from "../../src/services/pi/live/PiSettingsLive";
import { CakeSessionRuntimes } from "../../src/services/pi/CakeSessionRuntimes";
import { piSettingsHandlers } from "../../src/ipc/server/PiSettingsHandlers";
import { makeTaskInputStorageLive } from "../../src/services/storage/TaskInputStorageLive";
import { TaskInputStorage } from "../../src/services/storage/TaskInputStorage";
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
import { CAKE_CHAT_SESSION_ID } from "../../src/contracts/cake-chats/cake-chat-data";
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
  const sessionDir = join(directory, "global-chat", "sessions");
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
  const started = Deferred.makeUnsafe<void>();
  let hold = false;
  const finishes: Array<() => void> = [];
  let answer: (index: number) => ReturnType<typeof durableAnswer> = () => durableAnswer("Done");
  const streamSimple: Provider["streamSimple"] = (selected, request, options) => {
    requests.push(structuredClone(request));
    keys.push(options?.apiKey);
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
  const open = async (globalControl?: CakeSessionRuntimeSetup["globalControl"]) => {
    const runtime = await serviceRuntime.runPromise(
      service.createRuntime({
        cwd: directory,
        trusted: true,
        agentDir,
        sessionDir,
        resolvedSessionDir: join(directory, "global-chat", "resolved-sessions"),
        sessionId: CAKE_CHAT_SESSION_ID,
        requestUi: async () => undefined,
        globalControl: globalControl ?? { tools: [], invoke: async () => ({}) },
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
  return {
    directory,
    agentDir,
    sessionDir,
    service,
    serviceRuntime,
    requests,
    keys,
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

it("uses production SQLite, existing credentials and exact originals across reopen; purges only global JSONL roots", async () => {
  const f = await fixture();
  const old = join(f.sessionDir, "old.jsonl");
  const resolved = join(f.directory, "global-chat", "resolved-sessions", "old.jsonl");
  const project = join(f.directory, "project-sessions", "project.jsonl");
  for (const path of [old, resolved, project]) {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "original history");
  }
  const original = `ANCIENT_DETAIL ${"original words ".repeat(200)}`;
  f.answer(() => durableAnswer(original));
  const first = await f.open();
  await first.runtime.prompt("Remember this", "prompt", [], true, ids.first);
  expect(f.keys).toEqual(["fixture-key"]);
  expect(JSON.stringify(f.requests[0])).not.toContain("cake-input-presentation");
  const offered = f.requests[0]?.messages.flatMap((message) =>
    message.role === "system" ? (message.toolsAdded?.map((tool) => tool.name) ?? []) : [],
  );
  expect(offered).toEqual(["cake", "zoom", "date"]);
  expect(
    (await first.runtime.snapshot()).parts.some(
      (part) => part.kind === "text" && part.role === "user" && part.renderAs === "markdown",
    ),
  ).toBe(true);
  await expect(access(old)).rejects.toThrow();
  await expect(access(resolved)).rejects.toThrow();
  expect(await readFile(project, "utf8")).toBe("original history");
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
