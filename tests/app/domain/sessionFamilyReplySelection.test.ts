import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Stream } from "effect";
import { acquireOptions } from "../../../src/domain/project-sessions/projectSessionRuntime";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
} from "../../../src/domain/conversations/cross-session-coordination";
import { defaultApplicationState } from "../../../src/domain/application/application-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { makePiSessionsLayer, PiSessions } from "../../../src/services/pi/PiSessions";
import { makeProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";
import { familyStorageHarness } from "../helpers/familyStorageHarness";
import { fakeRuntime, snapshot } from "../helpers/piRuntimeFixture";

const location = {
  projectPath: "/project",
  projectName: "Project",
  workingDirectory: "/project",
  sessionDirectory: "/cake/sessions",
  resolvedSessionDirectory: "/cake/resolved",
};
const familyId = "4c41e44b-df48-4dfb-a891-d77748851586";
const threadA = "33cc9dc1-c84f-4fc1-a73c-3279de530b28";
const threadB = "72bcf93e-7888-4192-a8c8-311f011254da";
const requestA = "0b1bf3dd-458b-4025-8c39-c4f4e2febc0e";
const requestB = "2a709c5e-02a7-43aa-a5ce-bcaab29f231f";
const informational = "9485a6a1-018d-4a53-be20-f0c05126d3a7";
const unrelated = "237df372-2751-4740-849f-34a535ba43f4";

const message = (
  senderSessionId: string,
  messageId: string,
  threadId: string,
  expectsResponse: boolean,
) =>
  encodeCrossSessionMessage("Work", {
    version: 1,
    messageId,
    threadId,
    sequence: 1,
    expectsResponse,
    sender: { sessionId: senderSessionId, title: senderSessionId, kind: "project-session" },
  });

const initializeFamily = Effect.gen(function* () {
  const storage = yield* SessionFamilyStorage;
  for (const child of ["child", "sibling"])
    yield* storage.addChild({
      familyId,
      parentSessionId: "root",
      parentWorkingDirectory: "/project",
      childSessionId: child,
      childWorkingDirectory: "/project",
      requestId: child,
      projectPath: "/project",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
});

const environment = () =>
  Layer.mergeAll(
    familyStorageHarness().layer,
    makeProjectSessionRuntimeMechanismTestLayer(),
    SessionCatalogChanges.layer,
    Layer.mock(ApplicationState, {
      snapshot: () => ({
        ...defaultApplicationState(),
        projects: [
          {
            path: "/project",
            name: "Project",
            addedAt: "2026-01-01T00:00:00.000Z",
            lastOpenedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        trustedProjectPaths: ["/project"],
      }),
    }),
    Layer.mock(SessionArchiveStorage, { locate: () => Effect.succeed("active" as const) }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([]),
      proposeSquashMessage: () => Effect.void,
    }),
  );

const piLayer = (
  entered: Queue.Queue<string>,
  release: Deferred.Deferred<void>,
  delivered: Deferred.Deferred<void>,
  received: Array<{ target: string; text: string }>,
  executingIds: () => ReadonlyArray<string>,
) =>
  makePiSessionsLayer({
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(undefined),
    changelog: () => Effect.succeed(""),
    createRuntime: (options) =>
      Effect.succeed({
        ...fakeRuntime(options, () => undefined),
        sessionId: options.sessionId ?? "unknown",
        snapshot: async () => ({ ...snapshot, sessionId: options.sessionId ?? "unknown" }),
        executingTurnIds: () => (options.sessionId === "child" ? executingIds() : []),
        prompt: (text, delivery) => {
          if (options.sessionId !== "child") {
            received.push({ target: options.sessionId ?? "unknown", text });
            Deferred.doneUnsafe(delivered, Effect.void);
            return Promise.resolve();
          }
          return Effect.runPromise(
            Queue.offer(entered, delivery).pipe(Effect.andThen(Deferred.await(release))),
          );
        },
      }),
  });

it.effect("routes an automatic reply to the consumed request instead of later queued work", () =>
  Effect.gen(function* () {
    const entered = yield* Queue.unbounded<string>();
    const release = yield* Deferred.make<void>();
    const delivered = yield* Deferred.make<void>();
    const received: Array<{ target: string; text: string }> = [];
    let executing: ReadonlyArray<string> = [];
    yield* Effect.gen(function* () {
      yield* initializeFamily;
      const options = yield* acquireOptions({ location, sessionId: "child", newSession: false });
      const handle = yield* (yield* PiSessions).acquire(options);
      const activeTurnId = yield* handle.prompt(message("root", requestA, threadA, true));
      executing = [activeTurnId];
      yield* Queue.take(entered);
      yield* handle.followUp(message("sibling", requestB, threadA, true));
      yield* Queue.take(entered);
      yield* handle.followUp(message("root", informational, threadB, false));
      yield* Queue.take(entered);

      const route = options.runtime.currentSessionControl?.routeFamilyMessage;
      assert.ok(route);
      yield* Effect.tryPromise(() =>
        route(
          "sessions.reply",
          { text: "The active assignment is done." },
          new AbortController().signal,
        ),
      );
      yield* Deferred.await(delivered);

      assert.equal(received.length, 1);
      assert.equal(received[0]?.target, "root");
      assert.equal(
        parseCrossSessionMessage(received[0]?.text ?? "")?.metadata.replyToMessageId,
        requestA,
      );
      const pending = (yield* (yield* SessionFamilyStorage).state()).turns;
      assert.equal(pending.find((turn) => turn.requestMessageId === requestA)?.reported, true);
      assert.equal(pending.find((turn) => turn.requestMessageId === requestB)?.reported, false);
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.provide(
        Layer.mergeAll(
          environment(),
          piLayer(entered, release, delivered, received, () => executing),
        ),
      ),
    );
  }),
);

it.effect(
  "rejects queued or unrelated explicit replies while accepting the executing request",
  () =>
    Effect.gen(function* () {
      const entered = yield* Queue.unbounded<string>();
      const release = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const received: Array<{ target: string; text: string }> = [];
      let executing: ReadonlyArray<string> = [];
      yield* Effect.gen(function* () {
        yield* initializeFamily;
        const options = yield* acquireOptions({ location, sessionId: "child", newSession: false });
        const handle = yield* (yield* PiSessions).acquire(options);
        const activeTurnId = yield* handle.prompt(message("root", requestA, threadA, true));
        executing = [activeTurnId];
        yield* Queue.take(entered);
        yield* handle.followUp(message("root", requestB, threadB, true));
        yield* Queue.take(entered);

        const route = options.runtime.currentSessionControl?.routeFamilyMessage;
        assert.ok(route);
        assert.equal(
          yield* Effect.tryPromise(() =>
            route(
              "sessions.reply",
              { text: "Queued", threadId: threadB, replyToMessageId: requestB },
              new AbortController().signal,
            ),
          ),
          undefined,
        );
        assert.equal(
          yield* Effect.tryPromise(() =>
            route(
              "sessions.reply",
              { text: "Unrelated", threadId: threadA, replyToMessageId: unrelated },
              new AbortController().signal,
            ),
          ),
          undefined,
        );
        assert.equal(received.length, 0);

        yield* Effect.tryPromise(() =>
          route(
            "sessions.reply",
            { text: "Matching", threadId: threadA, replyToMessageId: requestA },
            new AbortController().signal,
          ),
        );
        yield* Deferred.await(delivered);
        assert.equal(received.length, 1);
        assert.equal(received[0]?.target, "root");
        assert.equal(
          parseCrossSessionMessage(received[0]?.text ?? "")?.metadata.replyToMessageId,
          requestA,
        );
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.provide(
          Layer.mergeAll(
            environment(),
            piLayer(entered, release, delivered, received, () => executing),
          ),
        ),
      );
    }),
);

it.effect("does not select a response request when no input is executing", () =>
  Effect.gen(function* () {
    const entered = yield* Queue.unbounded<string>();
    const release = yield* Deferred.make<void>();
    const delivered = yield* Deferred.make<void>();
    const received: Array<{ target: string; text: string }> = [];
    yield* Effect.gen(function* () {
      yield* initializeFamily;
      const options = yield* acquireOptions({ location, sessionId: "child", newSession: false });
      const handle = yield* (yield* PiSessions).acquire(options);
      yield* handle.followUp(message("root", requestA, threadA, true));
      yield* Queue.take(entered);

      const route = options.runtime.currentSessionControl?.routeFamilyMessage;
      assert.ok(route);
      assert.equal(
        yield* Effect.tryPromise(() =>
          route("sessions.reply", { text: "No match" }, new AbortController().signal),
        ),
        undefined,
      );
      assert.equal(received.length, 0);
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.provide(
        Layer.mergeAll(
          environment(),
          piLayer(entered, release, delivered, received, () => []),
        ),
      ),
    );
  }),
);
