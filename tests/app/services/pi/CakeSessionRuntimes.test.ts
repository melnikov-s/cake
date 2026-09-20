import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Scope, Stream } from "effect";
import { describe } from "vitest";
import {
  makeCakeSessionRuntimesLayer,
  CakeSessionRuntimes,
  type CakeSessionRuntimesAdapter,
  type CakeSessionRuntimeAcquireOptions,
} from "../../../../src/services/pi/CakeSessionRuntimes";
import { TurnCanceledError } from "../../../../src/services/pi/runtime/RuntimeTurnCompletion";
import { options, fakeRuntime } from "../../helpers/piRuntimeFixture";

const adapter = (
  acquisitions: Ref.Ref<number>,
  finalizations: Ref.Ref<number>,
): CakeSessionRuntimesAdapter => ({
  sessionIds: () => Stream.empty,
  catalog: () => Stream.empty,
  catalogEntry: () => Effect.succeed(undefined),
  inspect: () => Effect.succeed(undefined),
  createRuntime: (runtimeOptions) =>
    Ref.update(acquisitions, (count) => count + 1).pipe(
      Effect.as(
        fakeRuntime(runtimeOptions, () => {
          Ref.update(finalizations, (count) => count + 1).pipe(Effect.runSync);
        }),
      ),
    ),
  changelog: () => Effect.succeed("# Changelog"),
});

describe("CakeSessionRuntimes", () => {
  it.effect("delivers one aborted settlement even when the prompt finishes afterward", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const outcomes: string[] = [];
      let executingTurnIds: string[] = [];
      const layer = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (runtimeOptions) =>
          Effect.succeed({
            ...fakeRuntime(runtimeOptions, () => undefined),
            prompt: (_text, _delivery, _attachments, _markdown, turnId) => {
              if (turnId) executingTurnIds = [turnId];
              return Effect.runPromise(
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                  yield* Deferred.succeed(returned, undefined);
                }),
              );
            },
            executingTurnIds: () => executingTurnIds,
            abort: () =>
              Effect.runPromise(Deferred.succeed(release, undefined)).then(() => undefined),
          }),
      });
      const context = yield* Layer.build(layer);
      const sessions = Context.get(context, CakeSessionRuntimes);
      const handle = yield* sessions.acquire({
        ...options(),
        onTurnSettled: (event) =>
          Effect.sync(() => {
            outcomes.push(event.outcome);
          }),
      });
      yield* handle.prompt("work");
      yield* Deferred.await(started);
      yield* handle.abort();
      yield* Deferred.await(returned);
      assert.deepEqual(outcomes, ["aborted"]);
    }),
  );

  it.effect("settles withdrawn queued input as aborted and runtime failures as failed", () =>
    Effect.gen(function* () {
      const outcomes: Array<{ text: string; outcome: string }> = [];
      const settledTwice = yield* Deferred.make<void>();
      const layer = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (runtimeOptions) =>
          Effect.succeed({
            ...fakeRuntime(runtimeOptions, () => undefined),
            // A removed queue row rejects its correlation as a cancellation; a
            // broken delivery rejects with an ordinary error.
            prompt: (text: string) =>
              Promise.reject(
                text === "withdrawn"
                  ? new TurnCanceledError("Queued input was canceled")
                  : new Error("Provider unavailable"),
              ),
          }),
      });
      const context = yield* Layer.build(layer);
      const sessions = Context.get(context, CakeSessionRuntimes);
      const turnTexts = new Map<string, string>();
      const handle = yield* sessions.acquire({
        ...options(),
        admitTurn: (input, accept) =>
          Effect.sync(() => turnTexts.set(input.turnId, input.text)).pipe(Effect.andThen(accept)),
        onTurnSettled: (event) =>
          Effect.sync(() => {
            outcomes.push({ text: turnTexts.get(event.turnId) ?? "", outcome: event.outcome });
            if (outcomes.length === 2) Deferred.doneUnsafe(settledTwice, Effect.void);
          }),
      });
      yield* handle.followUp("withdrawn");
      yield* handle.followUp("broken");
      yield* Deferred.await(settledTwice);
      assert.deepEqual(
        [...outcomes].sort((left, right) => left.text.localeCompare(right.text)),
        [
          { text: "broken", outcome: "failed" },
          { text: "withdrawn", outcome: "aborted" },
        ],
      );
    }),
  );

  it.effect("passes queued input metadata at acceptance and settles only after execution", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const admissions: Array<{ turnId: string; text: string; delivery: string }> = [];
      const layer = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (runtimeOptions) =>
          Effect.succeed({
            ...fakeRuntime(runtimeOptions, () => undefined),
            prompt: () =>
              Effect.runPromise(
                Effect.gen(function* () {
                  yield* Deferred.succeed(started, undefined);
                  yield* Deferred.await(release);
                }),
              ),
          }),
      });
      const context = yield* Layer.build(layer);
      const sessions = Context.get(context, CakeSessionRuntimes);
      const handle = yield* sessions.acquire({
        ...options(),
        admitTurn: (input, accept) =>
          Effect.sync(() => admissions.push(input)).pipe(Effect.andThen(accept)),
        onTurnSettled: () => Deferred.succeed(settled, undefined),
      });
      yield* handle.followUp("queued coordination");
      assert.deepEqual(admissions, [
        {
          turnId: admissions[0]?.turnId,
          text: "queued coordination",
          delivery: "follow-up",
        },
      ]);
      yield* Deferred.await(started);
      assert.equal(Option.isNone(yield* Deferred.poll(settled)), true);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(settled);
    }),
  );

  it.effect("counts unconsumed input as active but permits resolution once execution settles", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let executingIds: string[] = [];
      let settle = () => undefined;
      const layer = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (runtimeOptions) => {
          settle = () => {
            runtimeOptions.onEvent({ type: "streaming", sessionId: "session-1", streaming: false });
          };
          return Effect.succeed({
            ...fakeRuntime(runtimeOptions, () => undefined),
            executingTurnIds: () => executingIds,
            prompt: (_text, _images, _mode, _presentation, turnId) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  executingIds = turnId ? [turnId] : [];
                  yield* Deferred.succeed(entered, undefined);
                  yield* Deferred.await(release);
                }),
              ),
          });
        },
      });
      const context = yield* Layer.build(layer);
      const sessions = Context.get(context, CakeSessionRuntimes);
      const handle = yield* sessions.acquire(options());
      yield* handle.prompt("work");
      yield* Deferred.await(entered);
      const target = {
        workingDirectory: "/project",
        sessionDirectory: "/sessions",
        sessionId: "session-1",
      };
      assert.equal((yield* sessions.currentStatus(target))?.streaming, true);
      const consumedIds = executingIds;
      executingIds = [];
      settle();
      assert.equal((yield* sessions.currentStatus(target))?.streaming, true);
      executingIds = consumedIds;
      settle();
      assert.equal((yield* sessions.currentStatus(target))?.streaming, false);
      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.effect("shares one keyed runtime and finalizes it after the last Scope releases", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();

      const first = yield* sessions
        .acquire(options())
        .pipe(Effect.provideService(Scope.Scope, firstScope));
      const second = yield* sessions
        .acquire(options())
        .pipe(Effect.provideService(Scope.Scope, secondScope));
      assert.equal(yield* Ref.get(acquisitions), 1);
      assert.notEqual(first, second);

      yield* Scope.close(firstScope, Exit.void);
      assert.equal(yield* Ref.get(finalizations), 0);
      yield* Scope.close(secondScope, Exit.void);
      assert.equal(yield* Ref.get(finalizations), 1);
    }),
  );

  it.effect("finalizes Cake integrations with the final shared runtime lease", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const integrationFinalizations = yield* Ref.make(0);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const acquireOptions: CakeSessionRuntimeAcquireOptions = {
        ...options(),
        onRelease: Ref.update(integrationFinalizations, (count) => count + 1),
      };

      yield* sessions.acquire(acquireOptions).pipe(Effect.provideService(Scope.Scope, firstScope));
      yield* sessions.acquire(acquireOptions).pipe(Effect.provideService(Scope.Scope, secondScope));
      yield* Scope.close(firstScope, Exit.void);
      assert.equal(yield* Ref.get(integrationFinalizations), 0);
      yield* Scope.close(secondScope, Exit.void);
      assert.equal(yield* Ref.get(finalizations), 1);
      assert.equal(yield* Ref.get(integrationFinalizations), 1);
    }),
  );

  it.effect("acquires the current runtime without reconstructing its options", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const owner = yield* Scope.make();
      const observer = yield* Scope.make();
      yield* sessions.acquire(options()).pipe(Effect.provideService(Scope.Scope, owner));

      const current = yield* sessions
        .acquireCurrent({
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          sessionId: "session-1",
        })
        .pipe(Effect.provideService(Scope.Scope, observer));
      assert.equal((yield* current.snapshot()).sessionId, "session-1");
      assert.equal(yield* Ref.get(acquisitions), 1);

      yield* Scope.close(owner, Exit.void);
      assert.equal(yield* Ref.get(finalizations), 0);
      yield* Scope.close(observer, Exit.void);
      assert.equal(yield* Ref.get(finalizations), 1);
    }),
  );

  it.effect("does not replay session creation after the assembled runtime is released", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const requestedCreationModes: Array<boolean | undefined> = [];
      const base = adapter(acquisitions, finalizations);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer({
          ...base,
          createRuntime: (runtimeOptions) => {
            requestedCreationModes.push(runtimeOptions.newSession);
            return base.createRuntime(runtimeOptions);
          },
        }),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const owner = yield* Scope.make();
      yield* sessions
        .acquire(options({ newSession: true }))
        .pipe(Effect.provideService(Scope.Scope, owner));
      yield* Scope.close(owner, Exit.void);

      const commandScope = yield* Scope.make();
      const result = yield* sessions
        .acquireSession("session-1")
        .pipe(Effect.provideService(Scope.Scope, commandScope), Effect.exit);
      assert.equal(Exit.isFailure(result), true);
      if (Exit.isFailure(result)) assert.match(String(result.cause), /has not been assembled/);
      assert.deepEqual(requestedCreationModes, [true]);
      assert.equal(yield* Ref.get(acquisitions), 1);
      yield* Scope.close(commandScope, Exit.void);
    }),
  );

  it.effect("reads current runtime status without acquiring or snapshotting a session", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const target = {
        workingDirectory: "/project",
        sessionDirectory: "/sessions",
        sessionId: "session-1",
      };

      assert.equal(yield* sessions.currentStatus(target), undefined);
      assert.equal(yield* Ref.get(acquisitions), 0);

      const owner = yield* Scope.make();
      yield* sessions.acquire(options()).pipe(Effect.provideService(Scope.Scope, owner));
      assert.deepEqual(yield* sessions.currentStatus(target), {
        streaming: false,
        pending: false,
        persisted: true,
      });
      assert.equal(yield* Ref.get(acquisitions), 1);

      yield* Scope.close(owner, Exit.void);
    }),
  );

  it.effect("awaits asynchronous runtime finalization after the last Scope releases", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finalizations = yield* Ref.make(0);
      const layer = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        createRuntime: (runtimeOptions) =>
          Effect.succeed(
            fakeRuntime(runtimeOptions, () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Ref.update(finalizations, (count) => count + 1)),
                Effect.runPromise,
              ),
            ),
          ),
        changelog: () => Effect.succeed("# Changelog"),
      });
      const context = yield* Layer.build(layer);
      const sessions = Context.get(context, CakeSessionRuntimes);
      const owner = yield* Scope.make();
      yield* sessions.acquire(options()).pipe(Effect.provideService(Scope.Scope, owner));

      const closing = yield* Scope.close(owner, Exit.void).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.equal(closing.pollUnsafe(), undefined);
      assert.equal(yield* Ref.get(finalizations), 0);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(closing);
      assert.equal(yield* Ref.get(finalizations), 1);
    }),
  );

  it.effect("releases a rejected conflicting acquisition immediately", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const retained = yield* Scope.make();
      yield* sessions.acquire(options()).pipe(Effect.provideService(Scope.Scope, retained));
      const conflictScope = yield* Scope.make();
      const conflict = yield* Effect.flip(
        sessions
          .acquire(options({ trusted: false }))
          .pipe(Effect.provideService(Scope.Scope, conflictScope)),
      );
      assert.equal(conflict._tag, "PiSessionError");
      assert.match(conflict.message, /conflicting runtime options/);

      // The failed acquisition must not retain the runtime for conflictScope.
      yield* Scope.close(retained, Exit.void);
      assert.equal(yield* Ref.get(finalizations), 1);
      yield* Scope.close(conflictScope, Exit.void);
      assert.equal(yield* Ref.get(finalizations), 1);
    }),
  );

  it.effect("emits one authoritative snapshot before buffered live events", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const handle = yield* sessions.acquire(options());
      const fiber = yield* handle.updates.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const updates = [...(yield* Fiber.join(fiber))];
      assert.equal(updates[0]?._tag, "Snapshot");
      assert.equal(updates[1]?._tag, "Event");
      if (updates[1]?._tag === "Event") assert.equal(updates[1].event.type, "streaming");
    }),
  );
});
