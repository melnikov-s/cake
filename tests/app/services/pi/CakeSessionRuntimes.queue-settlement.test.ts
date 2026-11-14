import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import {
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import {
  Context,
  Deferred,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  PlatformError,
  Queue,
  Stream,
} from "effect";
import { describe } from "vitest";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
  type CakeSessionRuntimeAcquireOptions,
} from "../../../../src/services/pi/CakeSessionRuntimes";
import { createCakeSessionRuntimeTurnController } from "../../../../src/services/pi/runtime/cake-session-runtime-turn-controller";
import {
  makeRuntimeRecoveryStorageLive,
  RuntimeRecoveryStorage,
  type RuntimeRecoveryInput,
} from "../../../../src/services/storage/RuntimeRecoveryStorage";
import { fakeRuntime, options } from "../../helpers/piRuntimeFixture";
import { durableModel } from "../../../fixtures/durable-chat";
import { addResponseModeReminder } from "../../../../src/contracts/conversations/response-mode-reminders";

type Settlement = Parameters<NonNullable<CakeSessionRuntimeAcquireOptions["onTurnSettled"]>>[0];
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const input = (turnId: string): RuntimeRecoveryInput => ({
  turnId,
  text: turnId,
  delivery: "follow-up",
  attachments: [],
  markdown: false,
});

// Keep Cake's runtime, turn controller, completion correlations and durable journal
// real. Only the Pi execution boundary is controlled by explicit release signals.
const fixture = Effect.fn("QueueSettlement.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-queue-settlement-" });
  let failNextSave = false;
  const storageLayer = makeRuntimeRecoveryStorageLive(directory).pipe(
    Layer.provide(
      Layer.succeed(FileSystem.FileSystem, {
        ...fs,
        rename: (source, target) => {
          if (!failNextSave) return fs.rename(source, target);
          failNextSave = false;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "rename",
            }),
          );
        },
      }),
    ),
  );
  const storage = Context.get(yield* Layer.build(storageLayer), RuntimeRecoveryStorage);
  const activity = yield* Queue.unbounded<void>();
  const settlements = yield* Queue.unbounded<Settlement>();
  const deliveries = yield* Queue.unbounded<string>();
  const cleanupSettled = yield* Deferred.make<void>();
  const consumed = new Set<string>();
  const outcomes: Settlement[] = [];
  let release = Deferred.makeUnsafe<void>();
  let streaming = false;
  let steering: string[] = [];
  let followUp: string[] = [];
  let aborts = 0;
  let failNextRun = false;
  const settings = SettingsManager.inMemory();
  const sessionManager = SessionManager.inMemory("/project");
  const session = {
    model: { ...durableModel, input: ["text", "image"] },
    settingsManager: settings,
    sessionManager,
    get isStreaming() {
      return streaming;
    },
    isCompacting: false,
    isBashRunning: false,
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
    clearQueue: () => {
      const previous = { steering, followUp };
      steering = [];
      followUp = [];
      return previous;
    },
    steer: async (text: string) => {
      steering.push(text);
    },
    followUp: async (text: string) => {
      followUp.push(text);
    },
    prompt: async (text: string, opts?: { streamingBehavior?: string }) => {
      if (streaming) {
        (opts?.streamingBehavior === "steer" ? steering : followUp).push(text);
        Queue.offerUnsafe(deliveries, text);
        return;
      }
      if (failNextRun) throw new Error("Promoted run preparation failed");
      streaming = true;
      release = Deferred.makeUnsafe<void>();
      const turnId = controller.consumeUserMessage(text);
      if (turnId) consumed.add(turnId);
      sessionManager.appendMessage({ role: "user", content: text, timestamp: 0 });
      Queue.offerUnsafe(deliveries, text);
      await Effect.runPromise(Deferred.await(release));
      streaming = false;
      controller.settleTurn();
    },
    abort: async () => {
      aborts += 1;
      streaming = false;
      Deferred.doneUnsafe(release, Effect.void);
    },
  } as unknown as AgentSession;
  const controller = createCakeSessionRuntimeTurnController({
    session,
    isDisposed: () => false,
    allowUserBash: false,
    beforeIdleTurn: async () => undefined,
    withResponseRetries: (operation) => operation(),
    cancelResponseRetries: () => undefined,
    recovery: { onUserInput: () => undefined, onAbort: () => undefined },
    deliverTrackedUserMessage: (_content, _markdown, deliver) => deliver(),
    syncQueuedParts: () => undefined,
    emitPart: () => undefined,
    emitSnapshot: async () => undefined,
    emitSnapshotInBackground: () => undefined,
    onAbortSettled: () => Deferred.doneUnsafe(cleanupSettled, Effect.void),
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
  const context = yield* Layer.build(
    makeCakeSessionRuntimesLayer({
      sessionIds: () => Stream.empty,
      catalog: () => Stream.empty,
      catalogEntry: () => Effect.succeed(undefined),
      inspect: () => Effect.succeed(undefined),
      changelog: () => Effect.succeed(""),
      createRuntime: (runtimeOptions) =>
        Effect.succeed({
          ...fakeRuntime(runtimeOptions, () => controller.dispose()),
          prompt: (
            text,
            delivery,
            attachments,
            markdown,
            turnId,
            presentation,
            _title,
            response,
            internal,
          ) =>
            controller.prompt(
              text,
              delivery,
              attachments,
              markdown,
              turnId,
              presentation,
              response,
              internal,
            ),
          toolPrune: () =>
            controller.withToolPruning(async () => ({
              sessionId: "session-1",
              sessionFile: "/project/session.jsonl",
            })),
          pendingMessages: controller.pendingMessages,
          pendingRecoveryInputs: controller.pendingRecoveryInputs,
          executingTurnIds: controller.executingTurnIds,
          hasConsumedInput: (id) => consumed.has(id),
          reorderPendingMessage: controller.reorderPendingMessage,
          updateQueuedMessage: controller.updateQueuedMessage,
          steerQueuedMessage: controller.steerQueuedMessage,
          removeQueuedMessage: controller.removeQueuedMessage,
          clearQueue: controller.clearQueue,
          sendQueuedMessageNow: controller.sendQueuedMessageNow,
          abort: controller.abort,
          waitForStop: controller.waitForStop,
        }),
    }).pipe(Layer.provide(Layer.succeed(RuntimeRecoveryStorage, storage))),
  );
  const sessions = Context.get(context, CakeSessionRuntimes);
  const handle = yield* sessions.acquire({
    ...options(),
    onTurnActivityChanged: Queue.offer(activity, undefined),
    onTurnSettled: (event) =>
      Effect.sync(() => {
        outcomes.push(event);
        Queue.offerUnsafe(settlements, event);
      }),
  });
  const submit = Effect.fn("QueueSettlement.submit")(function* (
    value: RuntimeRecoveryInput,
    verifyDelivery: (content: string) => void = (content) => assert.equal(content, value.text),
  ) {
    yield* handle.submit(value);
    yield* Queue.take(activity); // admission
    const delivered = yield* Queue.take(deliveries);
    verifyDelivery(delivered);
  });
  const settled = Effect.fn("QueueSettlement.settled")(function* (turnId: string, outcome: string) {
    const event = yield* Queue.take(settlements);
    assert.equal(event.turnId, turnId);
    assert.equal(event.outcome, outcome);
    yield* Queue.take(activity); // after journal cleanup, not just the callback
  });
  const partId = Effect.fn("QueueSettlement.partId")(function* (text: string) {
    const item = (yield* handle.pendingMessages()).items.find((item) => item.text === text);
    assert.ok(item?.partId);
    return item.partId;
  });
  // A fresh storage instance reads the persisted record, not the live cache.
  const reopened = () =>
    Effect.flatMap(RuntimeRecoveryStorage, (next) => next.get("session-1")).pipe(
      Effect.provide(Layer.fresh(storageLayer)),
    );
  return {
    handle,
    submit,
    settled,
    partId,
    reopened,
    pendingRecoveryInputs: controller.pendingRecoveryInputs,
    failNextSave: () => {
      failNextSave = true;
    },
    outcomes,
    settings,
    aborts: () => aborts,
    nextDelivery: () => Queue.take(deliveries),
    cleanupSettled: Deferred.await(cleanupSettled),
    finish: () => Deferred.succeed(release, undefined),
    failNextRun: () => {
      failNextRun = true;
    },
  };
});

describe("CakeSessionRuntimes queue settlement", () => {
  it.effect("edits, steers and reorders mixed metadata queues through real recovery storage", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const reminder: RuntimeRecoveryInput = {
        ...input("reminder"),
        text: "review this",
        internal: {
          _tag: "UserWithReminders",
          text: "review this",
          userText: "review this",
          notices: [],
          updates: [
            {
              id: "update",
              text: "background result",
              source: { title: "worker", href: "cake://session/worker" },
            },
          ],
          reportNotices: [],
        },
        attachments: [
          {
            kind: "input",
            id: "00000000-0000-4000-8000-000000000001",
            name: "context.txt",
            mimeType: "text/plain",
            byteLength: 20,
          },
        ],
        markdown: true,
        presentationMode: "browser",
        responseMode: "voice",
      };
      for (const value of [
        input("active"),
        input("plain-1"),
        reminder,
        input("plain-2"),
        { ...reminder, turnId: "reminder-2" },
      ])
        yield* f.submit(value, (delivered) => {
          if (value.internal) assert.match(delivered, /review this/);
          else
            assert.equal(
              delivered,
              value.turnId === "plain-2" ? addResponseModeReminder(value.text, "text") : value.text,
            );
        });
      const before = yield* f.reopened();
      assert.ok(before);
      assert.equal(Object.hasOwn(f.pendingRecoveryInputs()[0] ?? {}, "internal"), false);
      yield* f.handle.updateQueuedMessage(yield* f.partId("plain-1"), "edited plain");
      // Attachments and response reminders affect visible content, so locate the reminder by its stable item order.
      const reminderPart = (yield* f.handle.pendingMessages()).items[1]?.partId;
      assert.ok(reminderPart);
      yield* f.handle.updateQueuedMessage(reminderPart, "edited reminder");
      yield* f.handle.steerQueuedMessage(yield* f.partId("plain-2"));
      const last = (yield* f.handle.pendingMessages()).items.at(-1);
      assert.ok(last);
      yield* f.handle.reorderPendingMessage({ itemId: last.itemId, position: 1 });
      const after = yield* f.reopened();
      assert.ok(after);
      const byId = new Map(before.inputs.map((entry) => [entry.turnId, entry]));
      assert.deepEqual(
        after.inputs,
        ["active", "plain-2", "reminder-2", "plain-1", "reminder"].map((id) => {
          const original = byId.get(id);
          assert.ok(original);
          if (id === "plain-2") return { ...original, delivery: "steer" };
          if (id === "plain-1") return { ...original, text: "edited plain" };
          if (id === "reminder")
            return {
              ...original,
              text: "edited reminder",
              internal: {
                ...reminder.internal,
                text: "edited reminder",
                userText: "edited reminder",
              },
            };
          return original;
        }),
      );
      assert.deepEqual(after.canceledInputIds, []);
      yield* f.finish();
      yield* f.settled("active", "complete");
      yield* f.handle.clearQueue();
      for (const id of ["plain-1", "reminder", "plain-2", "reminder-2"])
        yield* f.settled(id, "aborted");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("reports applied-but-unsaved edits without replacing the last durable queue", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.submit(input("active"));
      yield* f.submit(input("held"));
      const saved = yield* f.reopened();
      f.failNextSave();
      const failure = yield* Effect.flip(f.handle.steerQueuedMessage(yield* f.partId("held")));
      assert.match(
        failure.message,
        /runtime queue edit was applied.*recovery metadata could not be saved/,
      );
      assert.match(failure.message, /check the current queue/);
      assert.match(failure.message, /Cannot rename recovery metadata/);
      assert.doesNotMatch(failure.message, /Restore this file and retry/);
      assert.equal((yield* f.handle.pendingMessages()).items[0]?.lane, "steering");
      assert.deepEqual(yield* f.reopened(), saved);
      assert.deepEqual(yield* f.handle.currentTurnIds(), ["active", "held"]);
      yield* f.finish();
      yield* f.settled("active", "complete");
      yield* f.handle.clearQueue();
      yield* f.settled("held", "aborted");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("model handoff retains queued human turn IDs and recovery while continuing once", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.submit(input("active"));
      yield* f.submit(input("human-next"));
      const before = (yield* f.handle.pendingMessages()).items;
      const result = yield* f.handle.switchModel({
        provider: "fixture",
        modelId: "new",
        thinkingLevel: "off",
        fastMode: false,
      });
      assert.equal(result.status, "continued");
      yield* f.settled("active", "aborted");
      assert.equal(yield* f.nextDelivery(), "Continue.");
      const after = (yield* f.handle.pendingMessages()).items;
      assert.deepEqual(
        after.map((item) => [item.itemId, item.text]),
        before.map((item) => [item.itemId, item.text]),
      );
      const record = yield* f.reopened();
      assert.ok(record?.inputs.some((entry) => entry.turnId === "human-next"));
      assert.ok(!record?.canceledInputIds?.includes("human-next"));
    }).pipe(Effect.provide(platform)),
  );
  for (const cancel of ["remove", "clear"] as const) {
    it.effect(
      `${cancel} queued input while active preserves settlement and future automatic admissions`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.submit(input("active"));
          yield* f.submit(input("withdrawn"));
          if (cancel === "remove")
            yield* f.handle.removeQueuedMessage(yield* f.partId("withdrawn"));
          else yield* f.handle.clearQueue();
          yield* f.settled("withdrawn", "aborted");
          const record = yield* f.reopened();
          assert.equal(record?.state, "active");
          assert.deepEqual(
            record.inputs.map((item) => item.turnId),
            ["active"],
          );
          assert.deepEqual(record.canceledInputIds, ["withdrawn"]);
          assert.deepEqual(yield* f.handle.currentTurnIds(), ["active"]);
          yield* f.submit(input("automatic"));
          yield* f.finish();
          yield* f.settled("active", "complete");
          assert.equal((yield* f.reopened())?.state, "active");
          yield* f.handle.clearQueue();
          yield* f.settled("automatic", "aborted");
          assert.equal((yield* f.reopened())?.state, "complete");
          assert.deepEqual((yield* f.reopened())?.inputs, []);
        }).pipe(Effect.provide(platform)),
    );
  }

  for (const active of [true, false]) {
    it.effect(
      `explicit stop pauses recovery with ${active ? "active and queued" : "only queued"} input`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          yield* f.submit(input("active"));
          yield* f.submit(input("held"));
          if (!active) {
            yield* f.finish();
            yield* f.settled("active", "complete");
          }
          yield* f.handle.abort({ by: "user" });
          if (active) yield* f.settled("active", "aborted");
          const record = yield* f.reopened();
          assert.equal(record?.state, "stopped");
          assert.deepEqual(
            record.inputs.map((item) => item.turnId),
            ["held"],
          );
          assert.match(
            (yield* Effect.flip(f.handle.submit(input("automatic")))).message,
            /needs user input/,
          );
          yield* f.handle.clearQueue();
          yield* f.settled("held", "aborted");
          assert.equal((yield* f.reopened())?.state, "stopped");
        }).pipe(Effect.provide(platform)),
    );
  }

  it.effect.each([false, true])(
    "stop with queued inputs permits human input carrying reminders (compact first: %s)",
    (compactFirst) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.submit(input("active"));
        yield* f.submit(input("queued-1"));
        yield* f.submit(input("queued-2"));
        const before = (yield* f.handle.pendingMessages()).items;
        yield* f.handle.abort({ by: "user" });
        yield* f.settled("active", "aborted");
        yield* f.cleanupSettled;
        if (compactFirst) yield* f.handle.toolPrune("assistant-entry");
        assert.deepEqual((yield* f.handle.pendingMessages()).items, before);
        assert.deepEqual(
          f.outcomes.map((event) => event.turnId),
          ["active"],
        );
        assert.match(
          (yield* Effect.flip(f.handle.submit(input("automatic")))).message,
          /needs user input/,
        );
        yield* f.submit({
          ...input("human"),
          delivery: "prompt",
          internal: { _tag: "UserWithReminders", text: "human", userText: "human", notices: [] },
        });
        assert.deepEqual((yield* f.handle.pendingMessages()).items, before);
        yield* f.finish();
        yield* f.settled("human", "complete");
        yield* f.handle.clearQueue();
        yield* f.settled("queued-1", "aborted");
        yield* f.settled("queued-2", "aborted");
      }).pipe(Effect.provide(platform)),
  );

  for (const rejection of ["stale", "unsupported image"] as const) {
    it.effect(`rejected send-now (${rejection}) preserves callbacks and journal cleanup`, () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.submit(input("active"));
        yield* f.submit({
          ...input("queued"),
          attachments:
            rejection === "stale"
              ? []
              : [{ kind: "image", name: "image.png", mimeType: "image/png", data: "AAA=" }],
        });
        const id = rejection === "stale" ? "missing-part" : yield* f.partId("queued");
        f.settings.setBlockImages(true);
        const failure = yield* Effect.flip(f.handle.sendQueuedMessageNow(id));
        assert.match(
          failure.message,
          rejection === "stale" ? /no longer available/ : /cannot accept images/,
        );
        assert.equal(f.aborts(), 0);
        assert.deepEqual(yield* f.handle.currentTurnIds(), ["active", "queued"]);
        yield* f.finish();
        yield* f.settled("active", "complete");
        yield* f.handle.clearQueue();
        yield* f.settled("queued", "aborted");
        const record = yield* f.reopened();
        assert.equal(record?.state, "complete");
        assert.deepEqual(record.inputs, []);
        assert.deepEqual(
          f.outcomes.map(({ turnId, outcome }) => [turnId, outcome]),
          [
            ["active", "complete"],
            ["queued", "aborted"],
          ],
        );
      }).pipe(Effect.provide(platform)),
    );
  }

  it.effect("valid send-now transfers once without pausing remaining recovery", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.submit(input("active"));
      yield* f.submit(input("selected"));
      yield* f.submit(input("held"));
      const sending = yield* f.handle
        .sendQueuedMessageNow(yield* f.partId("selected"))
        .pipe(Effect.forkChild);
      assert.equal(yield* f.nextDelivery(), "selected");
      yield* f.settled("active", "aborted");
      const record = yield* f.reopened();
      assert.equal(record?.state, "active");
      assert.deepEqual(
        record.inputs.map((item) => item.turnId),
        ["selected", "held"],
      );
      yield* f.finish();
      yield* Fiber.join(sending);
      yield* f.settled("selected", "complete");
      yield* f.handle.clearQueue();
      yield* f.settled("held", "aborted");
      assert.equal(f.aborts(), 1);
      assert.deepEqual(
        f.outcomes.map(({ turnId, outcome }) => [turnId, outcome]),
        [
          ["active", "aborted"],
          ["selected", "complete"],
          ["held", "aborted"],
        ],
      );
      assert.deepEqual((yield* f.reopened())?.inputs, []);
      assert.equal((yield* f.reopened())?.state, "complete");
    }).pipe(Effect.provide(platform)),
  );

  it.effect("send-now failure after abort still settles and cleans the interrupted input", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.submit(input("active"));
      yield* f.submit(input("selected"));
      f.failNextRun();
      const failure = yield* Effect.flip(
        f.handle.sendQueuedMessageNow(yield* f.partId("selected")),
      );
      assert.match(failure.message, /preparation failed/);
      yield* f.settled("active", "aborted");
      assert.deepEqual(
        f.outcomes.map(({ turnId, outcome }) => [turnId, outcome]),
        [["active", "aborted"]],
      );
      const record = yield* f.reopened();
      assert.equal(record?.state, "active");
      assert.deepEqual(
        record.inputs.map((item) => item.turnId),
        ["selected"],
      );
      // Finish the still-owned selected correlation at fixture teardown.
    }).pipe(Effect.provide(platform)),
  );
});
