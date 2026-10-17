import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";
import { SessionCoordination } from "../../../src/services/session-catalogs/SessionCoordination";
import { SessionCoordinationStorage } from "../../../src/services/storage/SessionCoordinationStorage";
import { SessionCoordinationStorageError } from "../../../src/contracts/storage/session-coordination-storage-errors";
import { coordinationStorageHarness } from "../helpers/coordinationStorageHarness";

const message = (messageId: string, targetSessionId = "child") => ({
  messageId,
  senderSessionId: "parent",
  targetSessionId,
  turnId: messageId,
  delivery: "queue" as const,
  status: "queued" as const,
});

describe("durable SessionCoordination", () => {
  it.effect(
    "retains pending correlation, latest reply target, turn binding, outcomes and closure across recreation",
    () => {
      const files = new Map<string, string>();
      const layer = () =>
        SessionCoordination.layer.pipe(Layer.provide(coordinationStorageHarness(files).layer));
      return Effect.gen(function* () {
        const threadId = yield* Effect.gen(function* () {
          const service = yield* SessionCoordination;
          const first = yield* service.create("parent", "child", 2);
          yield* service.record(first, message("request"));
          // Creating another empty thread must not change the most recent inbound reply target.
          yield* service.create("parent", "child");
          return first.threadId;
        }).pipe(Effect.provide(layer()));

        yield* Effect.gen(function* () {
          const service = yield* SessionCoordination;
          const thread = yield* service.find("child");
          assert.equal(thread?.threadId, threadId);
          assert.equal(thread?.maxMessages, 2);
          assert.equal(thread?.messages[0]?.messageId, "request");
          assert.equal(thread?.messages[0]?.turnId, "request");
          assert.equal(yield* service.find("outsider", threadId), undefined);
          yield* service.bindTurn("child", "request", "actual-turn");
        }).pipe(Effect.provide(layer()));

        yield* Effect.gen(function* () {
          const service = yield* SessionCoordination;
          const thread = yield* service.get(threadId);
          assert.ok(thread);
          const inbound = thread.messages[0];
          assert.ok(inbound);
          assert.equal(inbound.turnId, "actual-turn");
          assert.equal(yield* service.outcome(inbound), undefined);
          yield* service.settleTurn("actual-turn", "complete");
          // Recovery retries must not replace a terminal outcome with a later interruption.
          yield* service.settleTurn("actual-turn", "aborted");
          yield* service.record(thread, message("reply", "parent"));
          yield* service.close(thread);
        }).pipe(Effect.provide(layer()));

        yield* Effect.gen(function* () {
          const service = yield* SessionCoordination;
          const thread = yield* service.find("parent");
          assert.ok(thread);
          assert.equal(thread.threadId, threadId);
          assert.equal(thread.state, "closed");
          assert.equal(thread.messages.length, thread.maxMessages);
          const inbound = thread.messages[0];
          assert.ok(inbound);
          assert.equal(yield* service.outcome({ ...inbound }), "complete");
          yield* service.record(thread, { ...inbound });
          assert.equal(thread.messages.length, 2);
        }).pipe(Effect.provide(layer()));
      });
    },
  );

  it.effect("does not acknowledge or mutate memory when the durable write fails", () =>
    Effect.gen(function* () {
      const service = yield* SessionCoordination;
      const thread = yield* service.get("thread");
      assert.ok(thread);
      assert.equal((yield* Effect.exit(service.close(thread)))._tag, "Failure");
      assert.equal(thread.state, "open");
      assert.equal(
        (yield* Effect.exit(service.record(thread, message("uncommitted"))))._tag,
        "Failure",
      );
      assert.deepEqual(thread.messages, []);
      assert.equal(yield* service.find("child"), undefined);
    }).pipe(
      Effect.provide(
        SessionCoordination.layer.pipe(
          Layer.provide(
            Layer.mock(SessionCoordinationStorage, {
              load: () =>
                Effect.succeed({
                  threads: [
                    {
                      threadId: "thread",
                      participants: ["parent", "child"],
                      messages: [],
                      state: "open",
                    },
                  ],
                  latest: [],
                  outcomes: [],
                }),
              save: () =>
                Effect.fail(
                  new SessionCoordinationStorageError({
                    operation: "save",
                    message: "disk unavailable",
                  }),
                ),
            }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "keeps startup available but refuses coordination mutations when the catalog needs repair",
    () => {
      const files = new Map([
        ["state/session-coordination.json", JSON.stringify({ version: 99, data: {} })],
      ]);
      return Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const service = yield* SessionCoordination;
          const error = yield* Effect.flip(service.checkStorage());
          assert.equal(error._tag, "SessionCoordinationStorageError");
          assert.match(error.message, /Unsupported/);
          assert.match(error.message, /state\/session-coordination.json/);
          const admission = yield* Effect.flip(service.create("parent", "child"));
          assert.equal(admission.message, error.message);
          assert.equal(yield* service.find("parent"), undefined);
          assert.equal(
            JSON.parse(files.get("state/session-coordination.json") ?? "{}").version,
            99,
          );
        }).pipe(
          Effect.provide(
            SessionCoordination.layer.pipe(Layer.provide(coordinationStorageHarness(files).layer)),
          ),
        );
      });
    },
  );
});
