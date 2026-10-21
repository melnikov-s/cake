import { it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Fiber, FileSystem, Layer, Queue, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vitest";
import { projectChatSessionId } from "../../../src/domain/cake-chats/cakeChatLocations";
import * as cakeChatTargets from "../../../src/domain/cake-chats/cakeChatTargets";
import type { CakeSessionHandle } from "../../../src/services/pi/CakeSessionRuntimes";
import { makeScheduledMessageStorageLive } from "../../../src/services/storage/ScheduledMessageStorage";
import type { ProjectSessionPromptInput } from "../../../src/contracts/project-sessions/project-session-data";
import * as projectSessionOperations from "../../../src/domain/project-sessions/projectSessionOperations";
import { parseScheduledMessage } from "../../../src/contracts/conversations/scheduled-message-envelope";
import * as scheduledMessages from "../../../src/domain/scheduled-messages/scheduledMessages";
import type {
  ScheduledMessage,
  ScheduledMessageUpdate,
} from "../../../src/contracts/scheduled-messages/scheduled-message-data";
import { ScheduledMessages } from "../../../src/services/scheduled-messages/ScheduledMessages";
import { ScheduledMessageStorage } from "../../../src/services/storage/ScheduledMessageStorage";

const message: ScheduledMessage = {
  id: "8de1a807-dc99-49ee-8d35-7a3ed20bef06",
  targetSessionId: "session-1",
  text: "Check the build",
  sendAt: "2030-01-01T12:00:00.000Z",
  createdAt: "2026-09-04T12:00:00.000Z",
};

const makeLayer = (saved: ScheduledMessage[][]) =>
  ScheduledMessages.layer.pipe(
    Layer.provide(
      Layer.succeed(
        ScheduledMessageStorage,
        ScheduledMessageStorage.of({
          load: Effect.fn("ScheduledMessageStorage.Test.load")(() => Effect.succeed([])),
          save: Effect.fn("ScheduledMessageStorage.Test.save")((messages) =>
            Effect.sync(() => saved.push([...messages])),
          ),
        }),
      ),
    ),
  );

describe("ScheduledMessages", () => {
  it.effect("publishes destination-scoped updates and persists cancellation", () => {
    const saved: ScheduledMessage[][] = [];
    return Effect.gen(function* () {
      yield* scheduledMessages.initialize();
      const updates = yield* Queue.unbounded<ScheduledMessageUpdate>();
      const stream = yield* scheduledMessages.observe("session-1");
      yield* stream.pipe(
        Stream.runForEach((update) => Queue.offer(updates, update)),
        Effect.forkScoped,
      );

      expect(yield* Queue.take(updates)).toMatchObject({ _tag: "Snapshot", messages: [] });
      const state = yield* ScheduledMessages;
      yield* state.transact((current) => Effect.succeed([...current, message]));
      expect(yield* Queue.take(updates)).toMatchObject({
        _tag: "Event",
        event: { _tag: "Upserted", message },
      });

      yield* scheduledMessages.cancel(message.id);
      expect(yield* Queue.take(updates)).toMatchObject({
        _tag: "Event",
        event: { _tag: "Removed", id: message.id },
      });
      expect(saved).toEqual([[message], []]);
    }).pipe(Effect.provide(makeLayer(saved)));
  });

  it.effect("delivers a due message as an automatic send carrying its scheduled origin", () => {
    const saved: ScheduledMessage[][] = [];
    const sent: ProjectSessionPromptInput[] = [];
    const sendAutomatically = vi
      .spyOn(projectSessionOperations, "sendAutomatically")
      .mockImplementation((input) =>
        Effect.sync(() => {
          sent.push(input);
          return "turn-1" as never;
        }),
      );
    const due: ScheduledMessage = {
      ...message,
      createdAt: "1970-01-01T00:00:00.000Z",
      sendAt: "1970-01-01T00:00:05.000Z",
      createdBySessionId: "scheduler-session",
    };
    return Effect.gen(function* () {
      yield* scheduledMessages.initialize();
      const state = yield* ScheduledMessages;
      yield* state.transact((current) => Effect.succeed([...current, due]));

      // SAFETY: sendAutomatically is the worker's only Project Session dependency
      // and is replaced by the spy above, so its declared requirements never run.
      const worker = yield* Effect.forkScoped(
        scheduledMessages.runWorker as Effect.Effect<never, never, ScheduledMessages>,
      );
      yield* TestClock.adjust("1 second");
      expect(sent).toEqual([]);
      expect(yield* scheduledMessages.list("session-1")).toEqual([due]);

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.interrupt(worker);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        sessionId: "session-1",
        attachments: [],
        renderUserMessageAsMarkdown: false,
      });
      expect(parseScheduledMessage(sent[0]!.text)).toEqual({
        text: "Check the build",
        origin: {
          version: 1,
          id: due.id,
          createdAt: due.createdAt,
          sendAt: due.sendAt,
          createdBySessionId: "scheduler-session",
        },
      });
      expect(yield* scheduledMessages.list("session-1")).toEqual([]);
      expect(saved.at(-1)).toEqual([]);
    }).pipe(
      Effect.provide(makeLayer(saved)),
      Effect.ensuring(Effect.sync(() => sendAutomatically.mockRestore())),
    );
  });

  it.effect(
    "a due chat message wakes the chat directly, then a restarted recurring schedule advances",
    () => {
      const projectChat = projectChatSessionId("/project");
      const recurring: ScheduledMessage = {
        ...message,
        targetSessionId: projectChat,
        text: "Check the PR status",
        createdAt: "1970-01-01T00:00:00.000Z",
        sendAt: "1970-01-01T00:01:00.000Z",
        createdBySessionId: projectChat,
        repeatEverySeconds: 60,
        repeatUntil: "1970-01-01T00:05:00.000Z",
      };
      const delivered: Array<{ readonly via: string; readonly text: string }> = [];
      let streaming = false;
      const handle = {
        snapshot: () => Effect.sync(() => ({ streaming })),
        prompt: (text: string) =>
          Effect.sync(() => {
            delivered.push({ via: "prompt", text });
            return "turn";
          }),
        followUp: (text: string) =>
          Effect.sync(() => {
            delivered.push({ via: "follow-up", text });
            return "turn";
          }),
        publishSessionChanged: () => Effect.void,
      } as unknown as CakeSessionHandle;
      // SAFETY: the worker only reads snapshot().streaming and calls prompt/followUp/publish.
      const acquireAvailable = vi
        .spyOn(cakeChatTargets, "acquireAvailable")
        .mockImplementation((sessionId) => {
          expect(sessionId).toBe(projectChat);
          return Effect.succeed(handle) as never;
        });
      const sendAutomatically = vi.spyOn(projectSessionOperations, "sendAutomatically");
      const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
      const persisted = (directory: string) =>
        ScheduledMessages.layer.pipe(
          Layer.provide(makeScheduledMessageStorageLive(directory)),
          Layer.provide(platform),
        );
      // SAFETY: chat delivery dependencies are replaced by the spy above.
      const worker = scheduledMessages.runWorker as Effect.Effect<never, never, ScheduledMessages>;
      // Persistence is real file IO, so await the committed projection rather than elapsed time.
      const committed = (sendAt: string | undefined) =>
        Effect.gen(function* () {
          yield* (yield* ScheduledMessages).changes().pipe(
            Stream.filter((snapshot) => snapshot.messages[0]?.sendAt === sendAt),
            Stream.runHead,
          );
        });
      return Effect.gen(function* () {
        const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "cake-scheduled-messages-",
        });
        // First process: persist the schedule, then exit before it is due.
        yield* Effect.gen(function* () {
          yield* scheduledMessages.initialize();
          yield* (yield* ScheduledMessages).transact(() => Effect.succeed([recurring]));
        }).pipe(Effect.provide(persisted(directory)));

        // Restarted process: the schedule reloads from disk and fires at its boundary.
        yield* Effect.gen(function* () {
          expect(yield* scheduledMessages.initialize()).toMatchObject({ messages: [recurring] });
          const running = yield* Effect.forkScoped(worker);
          yield* TestClock.adjust("61 seconds");
          expect(delivered).toHaveLength(1);
          expect(delivered[0]?.via).toBe("prompt");
          expect(parseScheduledMessage(delivered[0]!.text)).toEqual({
            text: "Check the PR status",
            origin: {
              version: 1,
              id: recurring.id,
              createdAt: recurring.createdAt,
              sendAt: recurring.sendAt,
              createdBySessionId: projectChat,
            },
          });
          yield* committed("1970-01-01T00:02:00.000Z");
          expect(yield* scheduledMessages.list(projectChat)).toEqual([
            { ...recurring, sendAt: "1970-01-01T00:02:00.000Z" },
          ]);

          // A busy chat receives the next tick as a follow-up.
          streaming = true;
          yield* TestClock.adjust("60 seconds");
          yield* committed("1970-01-01T00:03:00.000Z");
          expect(delivered.map((item) => item.via)).toEqual(["prompt", "follow-up"]);
          yield* Fiber.interrupt(running);
        }).pipe(Effect.provide(persisted(directory)));

        // Cake stays closed across the 3:00 and 4:00 boundaries.
        yield* TestClock.adjust("130 seconds");

        // Another restart delivers the overdue tick once, skips missed boundaries, and the
        // last boundary within repeatUntil ends the repeat.
        yield* Effect.gen(function* () {
          yield* scheduledMessages.initialize();
          expect(yield* scheduledMessages.list()).toEqual([
            { ...recurring, sendAt: "1970-01-01T00:03:00.000Z" },
          ]);
          const running = yield* Effect.forkScoped(worker);
          yield* committed("1970-01-01T00:05:00.000Z");
          expect(delivered).toHaveLength(3);
          yield* TestClock.adjust("60 seconds");
          yield* committed(undefined);
          yield* Fiber.interrupt(running);
          expect(delivered).toHaveLength(4);
          expect(yield* scheduledMessages.list()).toEqual([]);
        }).pipe(Effect.provide(persisted(directory)));
        expect(sendAutomatically).not.toHaveBeenCalled();
      }).pipe(
        Effect.scoped,
        Effect.provide(platform),
        Effect.ensuring(
          Effect.sync(() => {
            acquireAvailable.mockRestore();
            sendAutomatically.mockRestore();
          }),
        ),
      );
    },
  );

  it.effect("cancelling a recurring message during delivery does not re-add it", () => {
    const recurring: ScheduledMessage = {
      ...message,
      createdAt: "1970-01-01T00:00:00.000Z",
      sendAt: "1970-01-01T00:01:00.000Z",
      repeatEverySeconds: 60,
    };
    const saved: ScheduledMessage[][] = [];
    const sending = Effect.runSync(Queue.unbounded<void>());
    const release = Effect.runSync(Queue.unbounded<void>());
    const sendAutomatically = vi
      .spyOn(projectSessionOperations, "sendAutomatically")
      .mockImplementation(() =>
        Queue.offer(sending, undefined).pipe(
          Effect.andThen(Queue.take(release)),
          Effect.as("turn-1" as never),
        ),
      );
    return Effect.gen(function* () {
      yield* scheduledMessages.initialize();
      yield* (yield* ScheduledMessages).transact(() => Effect.succeed([recurring]));
      // SAFETY: sendAutomatically is replaced by the spy above.
      const worker = yield* Effect.forkScoped(
        scheduledMessages.runWorker as Effect.Effect<never, never, ScheduledMessages>,
      );
      yield* TestClock.adjust("61 seconds");
      yield* Queue.take(sending);
      yield* scheduledMessages.cancel(recurring.id);
      yield* Queue.offer(release, undefined);
      yield* TestClock.adjust("1 second");
      yield* Fiber.interrupt(worker);
      expect(yield* scheduledMessages.list()).toEqual([]);
      // The post-delivery commit ran after the cancellation and kept the message removed.
      expect(saved).toEqual([[recurring], [], []]);
    }).pipe(
      Effect.provide(makeLayer(saved)),
      Effect.ensuring(Effect.sync(() => sendAutomatically.mockRestore())),
    );
  });
});
