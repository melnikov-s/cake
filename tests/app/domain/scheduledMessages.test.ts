import { it } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, vi } from "vitest";
import type { ProjectSessionPromptInput } from "../../../src/domain/project-sessions/project-session-data";
import * as projectSessionOperations from "../../../src/domain/project-sessions/projectSessionOperations";
import { parseScheduledMessage } from "../../../src/domain/scheduled-messages/scheduled-message-envelope";
import * as scheduledMessages from "../../../src/domain/scheduled-messages/scheduledMessages";
import type {
  ScheduledMessage,
  ScheduledMessageUpdate,
} from "../../../src/domain/scheduled-messages/scheduled-message-data";
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
});
