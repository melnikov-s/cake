import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Clock, Effect, Fiber, FileSystem, Layer, Queue, Stream } from "effect";
import { makeScheduledMessageStorageLive } from "../../../src/services/storage/ScheduledMessageStorage";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, vi } from "vitest";
import {
  CAKE_CHAT_SESSION_ID,
  SESSION_ASSISTANT_ID,
} from "../../../src/contracts/cake-chats/cake-chat-identity";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import * as cakeChatTargets from "../../../src/domain/cake-chats/cakeChatTargets";
import * as projectSessionOperations from "../../../src/domain/project-sessions/projectSessionOperations";
import * as projectSessionMetadata from "../../../src/domain/project-sessions/projectSessionMetadata";
import {
  CakeSessionRuntimes,
  PiSessionError,
  type CakeSessionHandle,
} from "../../../src/services/pi/CakeSessionRuntimes";
import type { RuntimeRecoveryInput } from "../../../src/services/storage/RuntimeRecoveryStorage";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import {
  encodeScheduledMessage,
  parseScheduledMessage,
  scheduledMessageOrigin,
} from "../../../src/contracts/conversations/scheduled-message-envelope";
import * as scheduledMessages from "../../../src/domain/scheduled-messages/scheduledMessages";
import type {
  ScheduledMessage,
  ScheduledMessageError,
  ScheduledMessageUpdate,
} from "../../../src/contracts/scheduled-messages/scheduled-message-data";
import type { ScheduledInputReceipt } from "../../../src/contracts/scheduled-messages/scheduled-input-receipt";
import type { PiPendingMessages } from "../../../src/contracts/conversations/pending-message-data";
import { ScheduledMessages } from "../../../src/services/scheduled-messages/ScheduledMessages";
import { ScheduledMessageStorage } from "../../../src/services/storage/ScheduledMessageStorage";

// SAFETY: this fixture replaces all target dependencies, leaving only its state services.
const cancel = (id: string) =>
  scheduledMessages.cancel(id) as Effect.Effect<
    void,
    ScheduledMessageError,
    ScheduledMessages | ApplicationState
  >;
const iso = (seconds: number) => new Date(seconds * 1_000).toISOString();
const message: ScheduledMessage = {
  id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
  targetSessionId: CAKE_CHAT_SESSION_ID,
  text: "Check the build",
  sendAt: iso(5),
  createdAt: iso(0),
  repeatEverySeconds: 120,
};

afterEach(() => vi.restoreAllMocks());

const fixture = Effect.fn("ScheduledMessagesTest.fixture")(function* (initial = [message]) {
  const clock = yield* Clock.Clock;
  let disk: readonly ScheduledMessage[] = initial;
  let failAdmission = false;
  let failPublication = false;
  let existingAvailable = true;
  const openedTargets: string[] = [];
  const admitted: RuntimeRecoveryInput[] = [];
  const receipts = new Map<string, ScheduledInputReceipt>();
  const queue: PiPendingMessages["items"][number][] = [];
  const removed: string[] = [];
  const promoted: string[] = [];
  const handle = {
    pendingMessages: () => Effect.sync(() => ({ items: [...queue] })),
    scheduledInputReceipt: (id: string) => Effect.sync(() => receipts.get(id)),
    submit: (input: RuntimeRecoveryInput) =>
      Effect.gen(function* () {
        if (failAdmission) {
          failAdmission = false;
          return yield* Effect.fail(new Error("Admission unavailable"));
        }
        if (!receipts.has(input.turnId)) {
          admitted.push(input);
          receipts.set(input.turnId, { status: "pending" });
          queue.push({
            itemId: input.turnId,
            turnId: input.turnId,
            partId: `queued-${input.turnId}`,
            text: input.text,
            lane: "steering",
            position: queue.length + 1,
            state: "queued",
          });
        }
        return input.turnId;
      }),
    removeQueuedMessage: (partId: string) =>
      Effect.sync(() => {
        const index = queue.findIndex((item) => (item.partId ?? item.itemId) === partId);
        if (index >= 0) {
          const [item] = queue.splice(index, 1);
          if (item) receipts.set(item.turnId ?? item.itemId, { status: "canceled" });
          removed.push(partId);
        }
        return { steering: [], followUp: [] };
      }),
    steerQueuedMessage: (partId: string) =>
      Effect.sync(() => {
        const index = queue.findIndex((item) => item.partId === partId);
        const item = queue[index];
        if (item) queue[index] = { ...item, lane: "steering" };
        promoted.push(partId);
        return { steering: [], followUp: [] };
      }),
    publishSessionChanged: () =>
      Effect.suspend(() =>
        failPublication
          ? ((failPublication = false),
            Effect.fail(new Error("Publication failed after admission")))
          : Effect.void,
      ),
  } as unknown as CakeSessionHandle;
  // The scoped acquisition boundary is replaced, never any live runtime or queue.
  vi.spyOn(cakeChatTargets, "acquireAvailable").mockImplementation((sessionId) => {
    openedTargets.push(sessionId);
    return Effect.succeed(handle) as never;
  });
  vi.spyOn(projectSessionOperations, "prepareAgentCommand").mockImplementation(({ sessionId }) => {
    openedTargets.push(sessionId);
    return Effect.succeed(handle) as never;
  });
  vi.spyOn(projectSessionMetadata, "inspect").mockImplementation(() => Effect.succeed({}) as never);
  const app = {
    ...defaultApplicationState(),
    projects: [{ path: "/project", name: "Project", addedAt: iso(0), lastOpenedAt: iso(0) }],
  };
  const layer = ScheduledMessages.layer.pipe(
    Layer.provide(
      Layer.succeed(ScheduledMessageStorage, {
        load: () => Effect.sync(() => disk),
        save: (messages) =>
          Effect.sync(() => {
            disk = [...messages];
          }),
      }),
    ),
  );
  const application = Layer.mock(ApplicationState, { snapshot: () => app });
  const existing = Layer.mock(CakeSessionRuntimes, {
    acquireSession: () =>
      Effect.suspend(() =>
        existingAvailable
          ? Effect.succeed(handle)
          : Effect.fail(
              new PiSessionError({
                operation: "acquireSession",
                message: "Session has not been assembled",
              }),
            ),
      ),
  });
  // SAFETY: all target acquisitions and metadata inspections are mocked above.
  const worker = scheduledMessages.runWorker as Effect.Effect<
    never,
    never,
    ScheduledMessages | ApplicationState
  >;
  const start = Effect.fn("ScheduledMessagesTest.start")(function* () {
    yield* scheduledMessages.initialize();
    return yield* worker.pipe(Effect.forkScoped);
  });
  const consume = (id: string) => {
    receipts.set(id, { status: "consumed", consumedAt: clock.currentTimeMillisUnsafe() });
    const index = queue.findIndex((item) => (item.turnId ?? item.itemId) === id);
    if (index >= 0) queue.splice(index, 1);
  };
  return {
    layer: Layer.mergeAll(layer, application, existing),
    openedTargets,
    closeExisting: () => {
      existingAvailable = false;
    },
    start,
    admitted,
    receipts,
    queue,
    removed,
    promoted,
    consume,
    disk: () => disk,
    app,
    failAdmission: () => {
      failAdmission = true;
    },
    failPublication: () => {
      failPublication = true;
    },
  };
});

describe("ScheduledMessages delivery-relative recurrence", () => {
  it.effect(
    "persists pending occurrence identity, cancellation and failure metadata through real storage reload",
    () =>
      Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "scheduled-delivery-",
        });
        const pending = {
          ...message,
          pendingOccurrenceId: "occurrence",
          cancelRequested: true,
          deliveryError: "Target unavailable",
        };
        const storageLayer = makeScheduledMessageStorageLive(directory);
        yield* Effect.gen(function* () {
          const storage = yield* ScheduledMessageStorage;
          yield* storage.save([pending]);
          expect(yield* storage.load()).toEqual([pending]);
        }).pipe(Effect.provide(storageLayer));
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer))),
  );

  it.effect(
    "repeatUntil ends recurrence based on actual delivery, and a withdrawn input never retries",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture([{ ...message, repeatUntil: iso(130) }]);
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("60 seconds");
          f.consume(f.admitted[0]!.turnId);
          yield* TestClock.adjust("1 second");
          expect(f.disk()).toEqual([]); // 60 + 120 is past repeatUntil.
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
        const canceled = yield* fixture();
        yield* Effect.gen(function* () {
          const running = yield* canceled.start();
          yield* TestClock.adjust("1 second");
          canceled.receipts.set(canceled.admitted[0]!.turnId, { status: "canceled" });
          canceled.queue.splice(0);
          yield* TestClock.adjust("1 second");
          expect(canceled.disk()).toEqual([]);
          expect(canceled.admitted).toHaveLength(1);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(canceled.layer));
      }),
  );
  for (const targetSessionId of [
    CAKE_CHAT_SESSION_ID,
    SESSION_ASSISTANT_ID,
    projectChatSessionId("/project"),
    "session-1",
  ]) {
    it.effect(
      `uses steering and exactly one pending occurrence across a blocked hour: ${targetSessionId}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture([{ ...message, targetSessionId }]);
          yield* Effect.gen(function* () {
            const running = yield* f.start();
            yield* TestClock.adjust("5 seconds");
            expect(f.admitted).toHaveLength(1);
            const input = f.admitted[0]!;
            expect(input.delivery).toBe("steer");
            expect(parseScheduledMessage(input.text)).toEqual({
              text: message.text,
              origin: scheduledMessageOrigin({ ...message, targetSessionId }),
            });
            yield* TestClock.adjust("60 minutes");
            expect(f.admitted).toHaveLength(1);
            expect(f.queue).toHaveLength(1);
            expect(f.disk()[0]).toMatchObject({
              sendAt: iso(5),
              pendingOccurrenceId: input.turnId,
            });
            f.consume(input.turnId); // Agent consumed at 3605, not at queue admission or reply completion.
            yield* TestClock.adjust("1 second");
            expect(f.disk()[0]).toMatchObject({ sendAt: iso(3725) });
            expect(f.disk()[0]?.pendingOccurrenceId).toBeUndefined();
            yield* TestClock.adjust("118 seconds");
            expect(f.admitted).toHaveLength(1);
            yield* TestClock.adjust("1 second");
            expect(f.admitted).toHaveLength(2);
            expect(f.admitted[1]?.turnId).not.toBe(input.turnId);
            yield* Fiber.interrupt(running);
          }).pipe(Effect.provide(f.layer));
        }),
    );
  }

  it.effect(
    "idle one-shot remains visible until consumed, then disappears without waiting for a reply",
    () =>
      Effect.gen(function* () {
        const { repeatEverySeconds: _, ...oneShot } = message;
        const f = yield* fixture([oneShot]);
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("5 seconds");
          expect(f.disk()).toHaveLength(1);
          f.consume(f.admitted[0]!.turnId);
          yield* TestClock.adjust("1 second");
          expect(f.disk()).toEqual([]);
          yield* TestClock.adjust("10 minutes");
          expect(f.admitted).toHaveLength(1);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "restarts before and after consumption preserve identity and the original acknowledgement time",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        let id = "";
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("5 seconds");
          id = f.admitted[0]!.turnId;
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("30 minutes");
          expect(f.admitted).toHaveLength(1);
          expect(f.disk()[0]?.pendingOccurrenceId).toBe(id);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
        f.consume(id); // Pi consumed at 1805, scheduler was not running to observe it.
        yield* TestClock.adjust("50 seconds");
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("1 second");
          expect(f.disk()[0]?.sendAt).toBe(iso(1925));
          expect(f.admitted).toHaveLength(1);
          // Duplicate observation must not slide the next due time.
          yield* TestClock.adjust("10 seconds");
          expect(f.disk()[0]?.sendAt).toBe(iso(1925));
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "retries failed admission and an ambiguous post-admission failure without duplicate injections",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        f.failAdmission();
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("5 seconds");
          expect(f.admitted).toHaveLength(0);
          const id = f.disk()[0]?.pendingOccurrenceId;
          expect(f.disk()[0]?.deliveryError).toContain("Admission unavailable");
          f.failPublication();
          yield* TestClock.adjust("1 second");
          expect(f.admitted).toHaveLength(1);
          expect(f.admitted[0]?.turnId).toBe(id);
          yield* TestClock.adjust("10 minutes");
          expect(f.admitted).toHaveLength(1);
          expect(f.disk()[0]?.deliveryError).toBeUndefined();
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "cancelling removes only its own pending input; separate schedules and human follow-ups survive",
    () =>
      Effect.gen(function* () {
        const other = {
          ...message,
          id: "b4e2a064-09ab-428b-a479-33546d017746",
          text: "Independent",
        };
        const f = yield* fixture([message, other]);
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("5 seconds");
          f.queue.push({
            itemId: "human",
            partId: "human",
            lane: "follow-up",
            position: 1,
            state: "queued",
            text: "Human follow-up",
          });
          yield* cancel(message.id);
          expect(f.disk().map((item) => item.id)).toEqual([other.id]);
          expect(f.queue.map((item) => item.text)).toContain("Human follow-up");
          expect(f.queue).toHaveLength(2);
          yield* TestClock.adjust("10 minutes");
          expect(f.admitted).toHaveLength(2);
          expect(f.removed).toHaveLength(1);
          expect(f.promoted).toEqual([]);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "coalesces legacy scheduled follow-ups and adopts the oldest exact input identity",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture([{ ...message, sendAt: iso(500) }]);
        for (const [index, sendAt] of [iso(5), iso(125), iso(245)].entries()) {
          const id = `legacy-${index}`;
          f.receipts.set(id, { status: "pending" });
          f.queue.push({
            itemId: id,
            turnId: id,
            partId: id,
            text: encodeScheduledMessage(
              message.text,
              scheduledMessageOrigin({ ...message, sendAt }),
            ),
            lane: "follow-up",
            position: index + 1,
            state: "queued",
          });
        }
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("1 second");
          expect(f.admitted).toEqual([]);
          expect(f.queue).toHaveLength(1);
          expect(f.queue[0]).toMatchObject({ itemId: "legacy-0", lane: "steering" });
          expect(f.disk()[0]).toMatchObject({ sendAt: iso(5), pendingOccurrenceId: "legacy-0" });
          f.consume("legacy-0");
          yield* TestClock.adjust("1 second");
          expect(f.disk()[0]?.sendAt).toBe(iso(121));
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect(
    "future schedules never assemble or restore a target just to look for legacy queues",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture([{ ...message, targetSessionId: "session-1", sendAt: iso(500) }]);
        f.closeExisting();
        yield* Effect.gen(function* () {
          const running = yield* f.start();
          yield* TestClock.adjust("10 seconds");
          expect(f.openedTargets).toEqual([]);
          expect(f.disk()).toEqual([
            { ...message, targetSessionId: "session-1", sendAt: iso(500) },
          ]);
          yield* TestClock.adjust("490 seconds");
          expect(f.openedTargets).toContain("session-1");
          expect(f.admitted).toHaveLength(1);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(f.layer));
      }),
  );

  it.effect("removed projects fail honestly and never retarget or admit the occurrence", () =>
    Effect.gen(function* () {
      const f = yield* fixture([{ ...message, targetSessionId: projectChatSessionId("/removed") }]);
      yield* Effect.gen(function* () {
        const running = yield* f.start();
        yield* TestClock.adjust("10 seconds");
        expect(f.admitted).toEqual([]);
        expect(f.disk()[0]?.deliveryError).toContain("no registered project");
        yield* Fiber.interrupt(running);
      }).pipe(Effect.provide(f.layer));
    }),
  );

  it.effect(
    "destination-scoped projections retain pending state and consumption-relative updates",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* Effect.gen(function* () {
          yield* scheduledMessages.initialize();
          const updates = yield* Queue.unbounded<ScheduledMessageUpdate>();
          yield* (yield* scheduledMessages.observe(CAKE_CHAT_SESSION_ID)).pipe(
            Stream.runForEach((update) => Queue.offer(updates, update)),
            Effect.forkScoped,
          );
          expect(yield* Queue.take(updates)).toMatchObject({
            _tag: "Snapshot",
            messages: [message],
          });
          yield* cancel(message.id);
          expect(yield* Queue.take(updates)).toMatchObject({
            _tag: "Event",
            event: { _tag: "Upserted", message: { cancelRequested: true } },
          });
          expect(yield* Queue.take(updates)).toMatchObject({
            _tag: "Event",
            event: { _tag: "Removed", id: message.id },
          });
        }).pipe(Effect.provide(f.layer));
      }),
  );
});
