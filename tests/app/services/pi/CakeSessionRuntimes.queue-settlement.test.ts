import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import {
  SessionManager,
  SettingsManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Context, Deferred, Effect, FileSystem, Fiber, Layer, Queue, Stream } from "effect";
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
  const storageLayer = makeRuntimeRecoveryStorageLive(directory);
  const storage = Context.get(yield* Layer.build(storageLayer), RuntimeRecoveryStorage);
  const activity = yield* Queue.unbounded<void>();
  const settlements = yield* Queue.unbounded<Settlement>();
  const deliveries = yield* Queue.unbounded<string>();
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
          prompt: (text, delivery, attachments, markdown, turnId, presentation, _title, response) =>
            controller.prompt(
              text,
              delivery,
              attachments,
              markdown,
              turnId,
              presentation,
              response,
            ),
          pendingMessages: controller.pendingMessages,
          pendingRecoveryInputs: controller.pendingRecoveryInputs,
          executingTurnIds: controller.executingTurnIds,
          hasConsumedInput: (id) => consumed.has(id),
          removeQueuedMessage: controller.removeQueuedMessage,
          clearQueue: controller.clearQueue,
          sendQueuedMessageNow: controller.sendQueuedMessageNow,
          abort: controller.abort,
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
  const submit = Effect.fn("QueueSettlement.submit")(function* (value: RuntimeRecoveryInput) {
    yield* handle.submit(value);
    yield* Queue.take(activity); // admission
    assert.equal(yield* Queue.take(deliveries), value.text);
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
    outcomes,
    settings,
    aborts: () => aborts,
    nextDelivery: () => Queue.take(deliveries),
    finish: () => Deferred.succeed(release, undefined),
    failNextRun: () => {
      failNextRun = true;
    },
  };
});

describe("CakeSessionRuntimes queue settlement", () => {
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
