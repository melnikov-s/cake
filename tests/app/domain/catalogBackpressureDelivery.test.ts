import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Stream } from "effect";
import * as TestClock from "effect/testing/TestClock";
import * as sessionChats from "../../../src/domain/conversations/sessionChats";
import { DELIVERY_RUNTIME_TIMEOUT } from "../../../src/domain/conversations/deliveryDeadlines";
import {
  CakeSessionRuntimes,
  makeCakeSessionRuntimesLayer,
} from "../../../src/services/pi/CakeSessionRuntimes";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { TaskInputStorage } from "../../../src/services/storage/TaskInputStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { unusedMessageLookupLayer } from "../helpers/heldAttentionHarness";
import {
  fakeRuntime,
  makeRuntimeRecoveryStorageTestLayer,
  options,
} from "../helpers/piRuntimeFixture";
import { projectTodoLayer } from "../helpers/projectTodoHarness";

const chats = [
  { sessionId: "chat-a", clientId: "0f4a7d2e-3b1c-4e5f-8a9b-1c2d3e4f5a6b" },
  { sessionId: "chat-b", clientId: "1f4a7d2e-3b1c-4e5f-8a9b-1c2d3e4f5a6b" },
];

/** Real Pi runtime handles and catalog, with a fake Pi that records each run it starts. */
function deliveryFixture() {
  const started: string[] = [];
  const runtimes = makeCakeSessionRuntimesLayer({
    sessionIds: () => Stream.empty,
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(undefined),
    changelog: () => Effect.succeed(""),
    createRuntime: (input) =>
      Effect.sync(() => {
        const runtime = fakeRuntime(input, () => undefined);
        const sessionId = input.sessionId ?? "unknown";
        return {
          ...runtime,
          sessionId,
          sessionFile: `/sessions/${sessionId}.jsonl`,
          snapshot: async () => ({ ...(await runtime.snapshot()), sessionId }),
          prompt: async (text) => {
            started.push(`${sessionId}: ${text}`);
          },
        };
      }),
  }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
  const layer = Layer.mergeAll(
    runtimes,
    SessionCatalogChanges.layer,
    projectTodoLayer(),
    unusedMessageLookupLayer,
    familyStorageHarness().layer,
    Layer.mock(TaskInputStorage, { isRecipient: () => Effect.succeed(false) }),
  );
  /** Opens both chats, as the app does, with turn activity published to the catalog. */
  const open = Effect.fn("CatalogBackpressureTest.open")(function* (
    onTurnActivityChanged?: Effect.Effect<void>,
  ) {
    const catalogs = yield* SessionCatalogChanges;
    const sessions = yield* CakeSessionRuntimes;
    for (const { sessionId } of chats)
      yield* sessions.acquire({
        ...options({ sessionId }),
        onTurnActivityChanged:
          onTurnActivityChanged ??
          catalogs.publish({
            _tag: "ProjectSessionActivityChanged",
            sessionId,
            projectPath: "/project",
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
          }),
        onSessionChanged: catalogs.publish({
          _tag: "ProjectSessionChanged",
          sessionId,
          projectPath: "/project",
          workingDirectory: "/project",
          resolved: false,
        }),
      });
  });
  /** Sends to both chats; each result is its turn id or its failure message. */
  const sendToBoth = Effect.fn("CatalogBackpressureTest.sendToBoth")(function* () {
    const sends = yield* Effect.forEach(chats, ({ sessionId, clientId }) =>
      sessionChats
        .deliver(
          {
            sessionId,
            text: `Hello ${sessionId}`,
            attachments: [],
            renderUserMessageAsMarkdown: false,
            clientId,
          },
          "prompt",
        )
        .pipe(
          Effect.scoped,
          Effect.match({ onSuccess: (turnId) => turnId, onFailure: (error) => error.message }),
          Effect.forkChild,
        ),
    );
    // Let both sends finish if they can, then pass the deadline a stuck admission would hit.
    for (let turn = 0; turn < 10_000 && sends.some((send) => !send.pollUnsafe()); turn++)
      yield* Effect.yieldNow;
    yield* TestClock.adjust(DELIVERY_RUNTIME_TIMEOUT);
    const results = yield* Effect.forEach(sends, Fiber.join);
    for (let turn = 0; turn < 200 && started.length < 2; turn++) yield* Effect.yieldNow;
    return results;
  });
  return { layer, started, open, sendToBoth };
}

// Recurrence: one catalog subscriber stopped reading, its 1,024-change buffer filled, and every
// later publish waited. Each send publishes while it holds turn admission, so every send in
// every chat timed out with "Cake could not hand this message to the agent" until a restart.
describe("delivery while a catalog subscriber has stopped reading", () => {
  it.effect("still admits and starts each chat's message", () => {
    const f = deliveryFixture();
    return Effect.gen(function* () {
      const catalogs = yield* SessionCatalogChanges;
      yield* f.open();
      // A subscriber that never reads past its stalled initial scan.
      const subscribed = yield* Deferred.make<void>();
      yield* catalogs
        .initialThenChanges(
          Stream.fromEffect(
            Deferred.succeed(subscribed, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        )
        .pipe(Stream.runDrain, Effect.forkScoped);
      yield* Deferred.await(subscribed);
      yield* Effect.forEach(
        Array.from({ length: 1_024 }, (_, index) => index),
        (index) =>
          catalogs.publish({
            _tag: "CakeChatSessionChanged",
            sessionId: `noise-${index}`,
            resolved: false,
          }),
        { discard: true },
      );

      expect(yield* f.sendToBoth()).toEqual(chats.map(({ clientId }) => clientId));
      expect(f.started.toSorted()).toEqual([
        expect.stringContaining("chat-a: Hello chat-a"),
        expect.stringContaining("chat-b: Hello chat-b"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });

  it.effect("a turn-activity listener that never returns does not hold admission", () => {
    const f = deliveryFixture();
    return Effect.gen(function* () {
      yield* f.open(Effect.never);
      expect(yield* f.sendToBoth()).toEqual(chats.map(({ clientId }) => clientId));
      expect(f.started).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(f.layer));
  });
});
