import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import {
  Context,
  Deferred,
  Clock,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";
import { describe } from "vitest";
import { TestClock } from "effect/testing";
import {
  makeCakeSessionRuntimesLayer,
  CakeSessionRuntimes,
  type CakeSessionRuntimesAdapter,
  type CakeSessionRuntimeAcquireOptions,
} from "../../../../src/services/pi/CakeSessionRuntimes";
import { CAKE_CHAT_SESSION_ID } from "../../../../src/contracts/cake-chats/cake-chat-identity";
import { TurnCanceledError } from "../../../../src/services/pi/runtime/RuntimeTurnCompletion";
import {
  RuntimeRecoveryStorage,
  RuntimeRecoveryStorageError,
} from "../../../../src/services/storage/RuntimeRecoveryStorage";
import {
  makeRuntimeRecoveryStorageTestLayer,
  options,
  fakeRuntime,
} from "../../helpers/piRuntimeFixture";

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
  it.effect(
    "retains an idle-compaction runtime until Pi settles even when its caller is interrupted",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        let finalizations = 0;
        const layer = makeCakeSessionRuntimesLayer({
          sessionIds: () => Stream.empty,
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (runtimeOptions) =>
            Effect.succeed({
              ...fakeRuntime(runtimeOptions, () => {
                finalizations += 1;
                Deferred.doneUnsafe(finalized, Effect.void);
              }),
              compactIfIdle: async () => {
                Deferred.doneUnsafe(started, Effect.void);
                await Effect.runPromise(Deferred.await(release));
                return { status: "compacted" };
              },
            }),
        }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
        const context = yield* Layer.build(layer);
        const sessions = Context.get(context, CakeSessionRuntimes);
        const operation = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* sessions.acquire(options());
            return yield* handle.compactIfIdle();
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const interruption = yield* Fiber.interrupt(operation).pipe(Effect.forkScoped);
        assert.equal(finalizations, 0);
        assert.equal(operation.pollUnsafe(), undefined);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(interruption);
        yield* Deferred.await(finalized);
        assert.equal(finalizations, 1);
      }),
  );

  it.effect(
    "idle-only compaction rejects accepted work before streaming and fails unsupported runtimes truthfully",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const layer = makeCakeSessionRuntimesLayer({
          sessionIds: () => Stream.empty,
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (runtimeOptions) =>
            Effect.succeed({
              ...fakeRuntime(runtimeOptions, () => undefined),
              prompt: async () => {
                Deferred.doneUnsafe(started, Effect.void);
                await Effect.runPromise(Deferred.await(release));
              },
            }),
        }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
        const context = yield* Layer.build(layer);
        const handle = yield* Context.get(context, CakeSessionRuntimes).acquire(options());
        const unsupported = yield* Effect.flip(handle.compactIfIdle());
        assert.match(unsupported.message, /Idle-only compaction is unavailable/);
        yield* handle.prompt("Preparing work");
        yield* Deferred.await(started);
        assert.deepEqual(yield* handle.compactIfIdle(), { status: "busy" });
        yield* Deferred.succeed(release, undefined);
      }),
  );

  it.effect(
    "keeps saved conversations readable with an actionable repair notice when recovery metadata is corrupt",
    () =>
      Effect.gen(function* () {
        const constructions = yield* Ref.make(0);
        const finalizations = yield* Ref.make(0);
        const problem = new RuntimeRecoveryStorageError({
          operation: "decode",
          message: "Restore /state/recovery-intents/broken.json and retry",
        });
        const storage = Layer.succeed(RuntimeRecoveryStorage, {
          get: () => Effect.fail(problem),
          list: () => Effect.fail(problem),
          update: () => Effect.fail(problem),
          remove: () => Effect.fail(problem),
        });
        yield* Effect.gen(function* () {
          const sessions = yield* CakeSessionRuntimes;
          const handle = yield* sessions.acquire(options());
          const snapshot = yield* handle.snapshot();
          const issue = snapshot.parts.find(
            (part) => part.kind === "notice" && part.id === "restart-recovery",
          );
          assert.ok(issue?.kind === "notice");
          assert.equal(issue.title, "Recovery metadata needs repair");
          assert.equal(issue.detail, problem.message);
          const status = yield* sessions.currentStatus({
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            sessionId: "session-1",
          });
          assert.equal(status?.recoveryIssue, problem.message);
          const submission = yield* Effect.flip(handle.prompt("Do not accept unrecoverable work"));
          assert.match(submission.message, /Restore/);
          assert.deepEqual(yield* handle.currentTurnIds(), []);
        }).pipe(
          Effect.provide(
            makeCakeSessionRuntimesLayer(adapter(constructions, finalizations)).pipe(
              Layer.provide(storage),
            ),
          ),
        );
      }),
  );
  it.effect(
    "fails new-session creation if preparation fails before persistence, but permits commands handled without a transcript",
    () =>
      Effect.gen(function* () {
        const layer = makeCakeSessionRuntimesLayer({
          sessionIds: () => Stream.empty,
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (runtimeOptions) =>
            Effect.succeed({
              ...fakeRuntime(runtimeOptions, () => undefined),
              prompt: async (text) => {
                if (text === "fail") throw new Error("Initial preparation failed");
              },
            }),
        }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
        const context = yield* Layer.build(layer);
        const handle = yield* Context.get(context, CakeSessionRuntimes).acquire(
          options({ newSession: true }),
        );
        const failed = yield* handle.prompt("fail").pipe(Effect.result);
        assert.equal(failed._tag, "Failure");
        if (failed._tag === "Failure")
          assert.equal(failed.failure.message, "Initial preparation failed");
        const command = yield* handle.prompt("/handled-command");
        assert.equal(typeof command, "string");
      }),
  );
  it.effect(
    "retains a queued command's runtime after the caller releases it, until execution or cancellation settles",
    () =>
      Effect.gen(function* () {
        const finalized = yield* Deferred.make<void>();
        let finalizations = 0;
        let settleCommand: () => void = () => undefined;
        const layer = makeCakeSessionRuntimesLayer({
          sessionIds: () => Stream.empty,
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (runtimeOptions) =>
            Effect.succeed({
              ...fakeRuntime(runtimeOptions, () => {
                finalizations += 1;
                Deferred.doneUnsafe(finalized, Effect.void);
              }),
              queueCommand: async (_command, onSettled) => {
                settleCommand = onSettled ?? (() => undefined);
                return {
                  itemId: "00000000-0000-4000-8000-000000000001",
                  status: "queued" as const,
                };
              },
            }),
        }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
        const context = yield* Layer.build(layer);
        const sessions = Context.get(context, CakeSessionRuntimes);
        const callerScope = yield* Scope.make();
        const handle = yield* sessions
          .acquire(options())
          .pipe(Effect.provideService(Scope.Scope, callerScope));
        const receipt = yield* handle.queueCommand("/toolcompact");
        assert.equal(receipt.status, "queued");
        yield* Scope.close(callerScope, Exit.void);
        assert.equal(finalizations, 0);
        settleCommand();
        yield* Deferred.await(finalized);
        assert.equal(finalizations, 1);
      }),
  );

  it.effect("serializes whole-queue edits across handles to the same runtime", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const attempted = yield* Deferred.make<void>();
      const edits: string[] = [];
      const layer = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (runtimeOptions) =>
          Effect.succeed({
            ...fakeRuntime(runtimeOptions, () => undefined),
            reorderPendingMessage: async () => {
              edits.push("reorder-start");
              await Effect.runPromise(
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
              );
              edits.push("reorder-end");
              return { items: [] };
            },
            removeQueuedMessage: async () => {
              edits.push("remove");
              return { steering: [], followUp: [] };
            },
          }),
      }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
      const context = yield* Layer.build(layer);
      const sessions = Context.get(context, CakeSessionRuntimes);
      const first = yield* sessions.acquire(options());
      const second = yield* sessions.acquire(options());
      const reorder = yield* first
        .reorderPendingMessage({ itemId: "00000000-0000-4000-8000-000000000000", position: 1 })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const remove = yield* Deferred.succeed(attempted, undefined).pipe(
        Effect.andThen(second.removeQueuedMessage("pending")),
        Effect.forkChild,
      );
      yield* Deferred.await(attempted);
      yield* Effect.yieldNow;
      assert.deepEqual(edits, ["reorder-start"]);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(reorder);
      yield* Fiber.join(remove);
      assert.deepEqual(edits, ["reorder-start", "reorder-end", "remove"]);
    }),
  );

  it.effect.each(["restart", "manual Continue"] as const)(
    "continues previously interrupted turns on %s without reporting a user stop or losing the original completion",
    (continuation) =>
      Effect.gen(function* () {
        const input = {
          turnId: "interrupted",
          text: "Original task",
          delivery: "prompt" as const,
          attachments: [],
          markdown: false,
        };
        const settlements = yield* Queue.unbounded<{
          turnId: string;
          outcome: string;
          stop?: unknown;
        }>();
        const recovered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const record = {
          sessionId: "session-1",
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          profile: "ProjectSession" as const,
          transcriptPersisted: false,
          state: "blocked" as const,
          issue: "Unfinished tool",
          inputs: [input],
        };
        const storageLayer = makeRuntimeRecoveryStorageTestLayer([record]);
        const layer = makeCakeSessionRuntimesLayer({
          sessionIds: () => Stream.empty,
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (runtimeOptions) =>
            Effect.succeed({
              ...fakeRuntime(runtimeOptions, () => undefined),
              recoverInput: async (restored) => {
                assert.equal(restored.turnId, input.turnId);
                Deferred.doneUnsafe(recovered, Effect.void);
                await Effect.runPromise(Deferred.await(release));
                runtimeOptions.onTurnResult?.(restored.turnId, {
                  stopReason: "stop",
                  text: "Verified effects",
                });
              },
              abort: async () => {
                throw new Error("Continuation must not abort");
              },
            }),
        }).pipe(Layer.provideMerge(storageLayer));
        const context = yield* Layer.build(layer);
        const sessions = Context.get(context, CakeSessionRuntimes);
        const storage = Context.get(context, RuntimeRecoveryStorage);
        const handle = yield* sessions.acquire({
          ...options(),
          onTurnSettled: (event) => Queue.offer(settlements, event).pipe(Effect.asVoid),
        });
        if (continuation === "restart") yield* handle.recover([input]);
        else yield* handle.prompt("Continue");
        yield* Deferred.await(recovered);
        const current = yield* storage.get("session-1");
        assert.equal(current?.state, "active");
        assert.equal(current?.issue, undefined);
        assert.equal(
          (yield* handle.snapshot()).parts.some((part) => part.id === "restart-recovery"),
          false,
        );
        yield* Deferred.succeed(release, undefined);
        const outcomes = [yield* Queue.take(settlements)];
        if (continuation === "manual Continue") outcomes.push(yield* Queue.take(settlements));
        assert.ok(outcomes.some((event) => event.turnId === input.turnId));
        assert.ok(
          outcomes.every((event) => event.outcome === "complete" && event.stop === undefined),
        );
        assert.equal((yield* storage.get("session-1"))?.state, "complete");
      }),
  );

  it.effect("delivers one aborted settlement even when the prompt finishes afterward", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const returned = yield* Deferred.make<void>();
      const outcomes: string[] = [];
      const stops: unknown[] = [];
      const runtimeStops: unknown[] = [];
      const activity: boolean[] = [];
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
            abort: (stop) => {
              runtimeStops.push(stop);
              return Effect.runPromise(Deferred.succeed(release, undefined)).then(() => undefined);
            },
          }),
      }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
      const context = yield* Layer.build(layer);
      const sessions = Context.get(context, CakeSessionRuntimes);
      const handle = yield* sessions.acquire({
        ...options(),
        onTurnActivityChanged: sessions
          .currentTurnIds({
            workingDirectory: "/project",
            sessionDirectory: "/sessions",
            sessionId: "session-1",
          })
          .pipe(
            Effect.map((turnIds) => {
              activity.push(turnIds.length > 0);
            }),
          ),
        onTurnSettled: (event) =>
          Effect.sync(() => {
            outcomes.push(event.outcome);
            stops.push(event.stop);
          }),
      });
      yield* handle.prompt("work");
      yield* Deferred.await(started);
      // The stop's attribution reaches both Pi's transcript marker and the settlement.
      const stop = { by: "session", sessionId: "cake-chat", title: "Cake Chat" } as const;
      yield* handle.abort(stop);
      yield* Deferred.await(returned);
      assert.deepEqual(outcomes, ["aborted"]);
      assert.deepEqual(stops, [stop]);
      assert.deepEqual(runtimeStops, [stop]);
      assert.deepEqual(activity, [true, false]);
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
      }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
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

  it.effect("settles a run without a final answer as failed with its reason, never complete", () =>
    Effect.gen(function* () {
      const exhausted =
        "Context exhausted: 245,384 of 250,000 context tokens were in use, so the response was cut off before it finished.";
      const results = {
        length: { stopReason: "length", text: "", errorMessage: exhausted },
        error: { stopReason: "error", text: "", errorMessage: "prompt is too long" },
        stop: { stopReason: "stop", text: "Final report: all checks passed." },
      } as const;
      const settlements = yield* Queue.unbounded<{
        outcome: string;
        message?: string;
        stopReason?: string;
      }>();
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer({
          sessionIds: () => Stream.empty,
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (runtimeOptions) =>
            Effect.succeed({
              ...fakeRuntime(runtimeOptions, () => undefined),
              // Pi's prompt resolves normally for each of these runs.
              prompt: async (text, _delivery, _attachments, _markdown, turnId) => {
                if (turnId)
                  runtimeOptions.onTurnResult?.(turnId, results[text as keyof typeof results]);
              },
            }),
        }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const handle = yield* sessions.acquire({
        ...options(),
        onTurnSettled: (event) =>
          Queue.offer(settlements, {
            outcome: event.outcome,
            ...(event.message ? { message: event.message } : null),
            ...(event.result ? { stopReason: event.result.stopReason } : null),
          }).pipe(Effect.asVoid),
      });
      const settled = [];
      for (const text of ["length", "error", "stop"]) {
        yield* handle.prompt(text);
        settled.push(yield* Queue.take(settlements));
      }
      assert.deepEqual(settled, [
        { outcome: "failed", message: exhausted, stopReason: "length" },
        { outcome: "failed", message: "prompt is too long", stopReason: "error" },
        { outcome: "complete", stopReason: "stop" },
      ]);
    }),
  );

  it.effect(
    "persists the latest successful turn before delayed failure reporting, including cold restoration",
    () =>
      Effect.gen(function* () {
        const failedReporting = yield* Deferred.make<void>();
        const releaseFailure = yield* Deferred.make<void>();
        const failureReturned = yield* Deferred.make<void>();
        const successReturned = yield* Deferred.make<void>();
        const storageContext = yield* Layer.build(makeRuntimeRecoveryStorageTestLayer());
        const storage = Context.get(storageContext, RuntimeRecoveryStorage);
        const runtimeAdapter: CakeSessionRuntimesAdapter = {
          sessionIds: () => Stream.empty,
          catalog: () => Stream.empty,
          catalogEntry: () => Effect.succeed(undefined),
          inspect: () => Effect.succeed(undefined),
          changelog: () => Effect.succeed(""),
          createRuntime: (runtimeOptions) =>
            Effect.succeed({
              ...fakeRuntime(runtimeOptions, () => undefined),
              prompt: async (text, _delivery, _attachments, _markdown, turnId) => {
                if (turnId)
                  runtimeOptions.onTurnResult?.(turnId, {
                    stopReason: text === "fail" ? "error" : "stop",
                    text: text === "fail" ? "" : "Recovered successfully",
                  });
              },
            }),
        };
        const layer = makeCakeSessionRuntimesLayer(runtimeAdapter).pipe(
          Layer.provide(Layer.succeed(RuntimeRecoveryStorage, storage)),
        );
        const context = yield* Layer.build(layer);
        const sessions = Context.get(context, CakeSessionRuntimes);
        const handle = yield* sessions.acquire({
          ...options(),
          onTurnSettled: (event) =>
            event.outcome === "failed"
              ? Deferred.succeed(failedReporting, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseFailure)),
                  Effect.andThen(Deferred.succeed(failureReturned, undefined)),
                )
              : Deferred.succeed(successReturned, undefined),
        });
        const target = {
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          sessionId: "session-1",
        };
        yield* handle.prompt("fail");
        yield* Deferred.await(failedReporting);
        assert.equal((yield* sessions.currentStatus(target))?.latestTurnOutcome, "failed");
        yield* handle.prompt("continue");
        yield* Deferred.await(successReturned);
        assert.equal((yield* sessions.currentStatus(target))?.latestTurnOutcome, "complete");
        yield* Deferred.succeed(releaseFailure, undefined);
        yield* Deferred.await(failureReturned);
        // A fresh service has no runtime or in-memory turn metadata: only the journal.
        const restored = Context.get(yield* Layer.build(Layer.fresh(layer)), CakeSessionRuntimes);
        assert.equal((yield* restored.currentStatus(target))?.latestTurnOutcome, "complete");
        assert.equal((yield* storage.get("session-1"))?.state, "complete");
      }),
  );

  it.effect(
    "a stopped turn can continue successfully and a subsequent fresh failure is retained",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const settled = yield* Queue.unbounded<string>();
        const storageContext = yield* Layer.build(makeRuntimeRecoveryStorageTestLayer());
        const storage = Context.get(storageContext, RuntimeRecoveryStorage);
        let executing: string[] = [];
        const context = yield* Layer.build(
          makeCakeSessionRuntimesLayer({
            sessionIds: () => Stream.empty,
            catalog: () => Stream.empty,
            catalogEntry: () => Effect.succeed(undefined),
            inspect: () => Effect.succeed(undefined),
            changelog: () => Effect.succeed(""),
            createRuntime: (runtimeOptions) =>
              Effect.succeed({
                ...fakeRuntime(runtimeOptions, () => undefined),
                executingTurnIds: () => executing,
                prompt: async (text, _delivery, _attachments, _markdown, turnId) => {
                  if (text === "stop me") {
                    executing = turnId ? [turnId] : [];
                    await Effect.runPromise(Deferred.succeed(started, undefined));
                    await Effect.runPromise(Deferred.await(release));
                  } else if (text === "fail again") throw new Error("Fresh failure");
                },
                abort: async () => {
                  executing = [];
                  Deferred.doneUnsafe(release, Effect.void);
                },
              }),
          }).pipe(Layer.provide(Layer.succeed(RuntimeRecoveryStorage, storage))),
        );
        const sessions = Context.get(context, CakeSessionRuntimes);
        const handle = yield* sessions.acquire({
          ...options(),
          onTurnSettled: (event) => Queue.offer(settled, event.outcome).pipe(Effect.asVoid),
        });
        const target = {
          workingDirectory: "/project",
          sessionDirectory: "/sessions",
          sessionId: "session-1",
        };
        yield* handle.prompt("stop me");
        yield* Deferred.await(started);
        yield* handle.abort({ by: "user" });
        assert.equal(yield* Queue.take(settled), "aborted");
        assert.equal((yield* sessions.currentStatus(target))?.latestTurnOutcome, "aborted");
        yield* handle.prompt("continue");
        assert.equal(yield* Queue.take(settled), "complete");
        assert.equal((yield* sessions.currentStatus(target))?.latestTurnOutcome, "complete");
        yield* handle.prompt("fail again");
        assert.equal(yield* Queue.take(settled), "failed");
        assert.equal((yield* sessions.currentStatus(target))?.latestTurnOutcome, "failed");
        assert.equal((yield* storage.get("session-1"))?.state, "failed");
      }),
  );

  it.effect("projects queued input and completed Pi runs as idle before bookkeeping settles", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const activity = yield* Queue.unbounded<void>();
      let streaming = false;
      let executingIds: string[] = [];
      let emitStreaming: (value: boolean) => void = () => undefined;
      const layer = makeCakeSessionRuntimesLayer({
        sessionIds: () => Stream.empty,
        catalog: () => Stream.empty,
        catalogEntry: () => Effect.succeed(undefined),
        inspect: () => Effect.succeed(undefined),
        changelog: () => Effect.succeed(""),
        createRuntime: (runtimeOptions) => {
          emitStreaming = (value) => {
            streaming = value;
            runtimeOptions.onEvent({ type: "streaming", sessionId: "session-1", streaming: value });
          };
          return Effect.succeed({
            ...fakeRuntime(runtimeOptions, () => undefined),
            get streaming() {
              return streaming;
            },
            executingTurnIds: () => executingIds,
            prompt: () =>
              Effect.runPromise(
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
              ),
          });
        },
      }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
      const context = yield* Layer.build(layer);
      const sessions = Context.get(context, CakeSessionRuntimes);
      const handle = yield* sessions.acquire({
        ...options(),
        onTurnActivityChanged: Queue.offer(activity, undefined).pipe(Effect.asVoid),
      });
      const target = {
        workingDirectory: "/project",
        sessionDirectory: "/sessions",
        sessionId: "session-1",
      };
      const turnId = yield* handle.followUp("Queued work");
      yield* Deferred.await(started);
      yield* Queue.take(activity);
      assert.equal((yield* sessions.currentStatus(target))?.streaming, false);
      assert.equal((yield* sessions.currentStatus(target))?.workingStartedAt, undefined);
      executingIds = [turnId];
      const startedAt = yield* Clock.currentTimeMillis;
      emitStreaming(true);
      yield* Queue.take(activity);
      assert.equal((yield* sessions.currentStatus(target))?.streaming, true);
      assert.equal((yield* sessions.currentStatus(target))?.workingStartedAt, startedAt);
      yield* TestClock.adjust("5 seconds");
      emitStreaming(true);
      yield* Queue.take(activity);
      assert.equal((yield* sessions.currentStatus(target))?.workingStartedAt, startedAt);
      emitStreaming(false);
      yield* Queue.take(activity);
      assert.equal((yield* sessions.currentStatus(target))?.streaming, false);
      assert.equal((yield* sessions.currentStatus(target))?.workingStartedAt, undefined);
      // The correlation still exists, but the actual Pi run has ended.
      assert.deepEqual(yield* handle.currentTurnIds(), [turnId]);
      yield* TestClock.adjust("2 seconds");
      emitStreaming(true);
      yield* Queue.take(activity);
      assert.equal((yield* sessions.currentStatus(target))?.workingStartedAt, startedAt + 7_000);
      emitStreaming(false);
      yield* Queue.take(activity);
      yield* Deferred.succeed(release, undefined);
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
      }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
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
      }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
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
      const workingStartedAt = (yield* sessions.currentStatus(target))?.workingStartedAt;
      assert.equal(workingStartedAt, yield* Clock.currentTimeMillis);
      const consumedIds = executingIds;
      executingIds = [];
      settle();
      assert.equal((yield* sessions.currentStatus(target))?.streaming, true);
      assert.equal((yield* sessions.currentStatus(target))?.workingStartedAt, workingStartedAt);
      executingIds = consumedIds;
      settle();
      assert.equal((yield* sessions.currentStatus(target))?.streaming, false);
      assert.equal((yield* sessions.currentStatus(target))?.workingStartedAt, undefined);
      yield* Deferred.succeed(release, undefined);
    }),
  );

  it.effect("shares one keyed runtime and finalizes it after the last Scope releases", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)).pipe(
          Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
        ),
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
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)).pipe(
          Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
        ),
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
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)).pipe(
          Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
        ),
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

  it.effect(
    "retains the permanent coordinator after its pane releases it so a report can wake it",
    () =>
      Effect.gen(function* () {
        const acquisitions = yield* Ref.make(0);
        const finalizations = yield* Ref.make(0);
        const received = yield* Deferred.make<string>();
        const applicationScope = yield* Scope.make();
        const base = adapter(acquisitions, finalizations);
        const context = yield* Layer.build(
          makeCakeSessionRuntimesLayer({
            ...base,
            createRuntime: (runtimeOptions) =>
              base.createRuntime(runtimeOptions).pipe(
                Effect.map((runtime) => ({
                  ...runtime,
                  sessionId: CAKE_CHAT_SESSION_ID,
                  prompt: async (text) => {
                    Deferred.doneUnsafe(received, Effect.succeed(text));
                  },
                })),
              ),
          }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
        ).pipe(Effect.provideService(Scope.Scope, applicationScope));
        const sessions = Context.get(context, CakeSessionRuntimes);
        const pane = yield* Scope.make();
        const globalOptions: CakeSessionRuntimeAcquireOptions = {
          profile: { _tag: "CakeChatSession" },
          runtime: {
            ...options({ sessionId: CAKE_CHAT_SESSION_ID }).runtime,
            globalControl: { tools: [], invoke: async () => ({ ok: true }) },
          },
        };
        yield* sessions.acquire(globalOptions).pipe(Effect.provideService(Scope.Scope, pane));
        yield* Scope.close(pane, Exit.void);
        assert.equal(yield* Ref.get(finalizations), 0);
        const reportScope = yield* Scope.make();
        const coordinator = yield* sessions
          .acquireSession(CAKE_CHAT_SESSION_ID)
          .pipe(Effect.provideService(Scope.Scope, reportScope));
        yield* coordinator.prompt("A substantive worker result wakes the idle coordinator.");
        assert.match(yield* Deferred.await(received), /substantive worker result/);
        assert.equal(yield* Ref.get(acquisitions), 1);
        yield* Scope.close(reportScope, Exit.void);
        yield* Scope.close(applicationScope, Exit.void);
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
        }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
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
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)).pipe(
          Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
        ),
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
        recoveryIssue: undefined,
        latestTurnOutcome: undefined,
      });
      assert.equal(yield* Ref.get(acquisitions), 1);

      yield* Scope.close(owner, Exit.void);
    }),
  );

  it.effect("reads the live transcript write time from one stat, without a catalog read", () =>
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "cake-modified-at-"));
      const sessionFile = join(directory, "session-1.jsonl");
      writeFileSync(sessionFile, "{}\n");
      const written = new Date("2026-03-04T05:06:07.000Z");
      utimesSync(sessionFile, written, written);
      let currentFile = sessionFile;
      const catalogReads = yield* Ref.make(0);
      const context = yield* Layer.build(
        makeCakeSessionRuntimesLayer({
          ...adapter(yield* Ref.make(0), yield* Ref.make(0)),
          catalogEntry: () =>
            Ref.update(catalogReads, (count) => count + 1).pipe(Effect.as(undefined)),
          createRuntime: (runtimeOptions) =>
            Effect.succeed(
              Object.defineProperty(
                fakeRuntime(runtimeOptions, () => undefined),
                "sessionFile",
                {
                  get: () => currentFile,
                },
              ),
            ),
        }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
      );
      const sessions = Context.get(context, CakeSessionRuntimes);
      const target = {
        workingDirectory: "/project",
        sessionDirectory: "/sessions",
        sessionId: "session-1",
      };
      assert.equal(yield* sessions.currentModifiedAt(target), undefined);

      const owner = yield* Scope.make();
      yield* sessions.acquire(options()).pipe(Effect.provideService(Scope.Scope, owner));
      assert.equal(yield* sessions.currentModifiedAt(target), written.toISOString());
      currentFile = join(directory, "missing.jsonl");
      assert.equal(yield* sessions.currentModifiedAt(target), undefined);
      assert.equal(yield* Ref.get(catalogReads), 0);

      yield* Scope.close(owner, Exit.void);
      rmSync(directory, { recursive: true, force: true });
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
      }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer()));
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
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)).pipe(
          Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
        ),
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
        makeCakeSessionRuntimesLayer(adapter(acquisitions, finalizations)).pipe(
          Layer.provide(makeRuntimeRecoveryStorageTestLayer()),
        ),
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
