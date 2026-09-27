import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Queue, Stream } from "effect";
import * as cakeChatLocations from "../../src/domain/cake-chats/cakeChatLocations";
import { openNetworkListener } from "../../src/server/NetworkListener";
import { connectClient } from "./fixtures/network-client";
import { makeNetworkTestBackend } from "./fixtures/network-backend";

it.live(
  "two network clients edit one durable saved Draft and only one activation submits a Pi turn",
  () =>
    Effect.gen(function* () {
      const backend = yield* makeNetworkTestBackend();
      const listener = yield* openNetworkListener(
        { port: 0, allowMissingOrigin: true },
        {
          homeDirectory: "/home/test",
          cakeChat: {
            agentDirectory: "/agent",
            location: cakeChatLocations.make({
              homeDirectory: "/home/test",
              sessionDirectory: "/chat",
              resolvedSessionDirectory: "/chat-resolved",
            }),
          },
        },
      ).pipe(Effect.provideContext(backend.context));
      assert.equal(listener.address._tag, "TcpAddress");
      const url = `ws://127.0.0.1:${listener.address.port}${listener.path}`;
      const first = yield* connectClient(url);
      const second = yield* connectClient(url);
      const observed =
        yield* Queue.unbounded<
          ReadonlyArray<{ sessionId: string; text: string; status: string }>
        >();
      yield* second.client["savedDrafts.observe"]({}).pipe(
        Stream.runForEach((records) => Queue.offer(observed, records)),
        Effect.forkScoped,
      );
      assert.deepEqual(yield* Queue.take(observed), []);
      const sessionId = crypto.randomUUID();
      const original = yield* first.client["savedDrafts.create"]({
        sessionId,
        projectPath: "/project",
        title: "Shared saved task",
        text: "First prompt",
        attachments: [],
        configuration: {
          provider: "test",
          modelId: "controlled",
          thinkingLevel: "off",
          fastMode: false,
        },
      });
      assert.equal(original.status, "saved");
      assert.equal(
        (yield* Queue.take(observed)).find((item) => item.sessionId === sessionId)?.text,
        "First prompt",
      );
      const bSnapshot = yield* second.client["savedDrafts.list"]({});
      assert.equal(bSnapshot.find((draft) => draft.sessionId === sessionId)?.text, "First prompt");
      const updated = yield* first.client["savedDrafts.update"]({
        record: { ...original, text: "Updated prompt" },
        expectedRevision: original.revision,
      });
      assert.equal(
        (yield* Queue.take(observed)).find((item) => item.sessionId === sessionId)?.text,
        "Updated prompt",
      );
      const stale = yield* Effect.result(
        second.client["savedDrafts.update"]({
          record: {
            ...bSnapshot.find((draft) => draft.sessionId === sessionId)!,
            text: "Stale prompt",
          },
          expectedRevision: original.revision,
        }),
      );
      assert.equal(stale._tag, "Failure");
      const results = yield* Effect.all(
        [
          Effect.result(
            first.client["savedDrafts.activate"]({
              sessionId,
              expectedRevision: updated.revision,
              workingDirectory: "/project",
            }),
          ),
          Effect.result(
            second.client["savedDrafts.activate"]({
              sessionId,
              expectedRevision: updated.revision,
              workingDirectory: "/project",
            }),
          ),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.equal(
        (yield* Queue.take(observed)).find((item) => item.sessionId === sessionId)?.status,
        "activating",
      );
      assert.equal(
        (yield* Queue.take(observed)).find((item) => item.sessionId === sessionId)?.status,
        "activated",
      );
      assert.equal(yield* Queue.take(backend.started), "Updated prompt");
      assert.equal(backend.stats.turns, 1);
      const records = yield* second.client["savedDrafts.list"]({});
      assert.equal(records.find((draft) => draft.sessionId === sessionId)?.status, "activated");
      assert.equal(
        records.find((draft) => draft.sessionId === sessionId)?.workingDirectory,
        "/project",
      );
      yield* Deferred.succeed(backend.finish, undefined);
      yield* Queue.take(backend.settled);
    }).pipe(Effect.scoped),
);
