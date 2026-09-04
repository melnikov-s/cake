import { it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { describe, expect } from "vitest";
import * as scheduledMessages from "../../../src/domain/scheduledMessages";
import type {
  ScheduledMessage,
  ScheduledMessageUpdate,
} from "../../../src/domain/scheduled-message-data";
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
});
