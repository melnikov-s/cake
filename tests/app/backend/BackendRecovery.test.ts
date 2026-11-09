import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, Scope } from "effect";
import { expect } from "vitest";
import {
  BackendRecovery,
  makeBackendRecoveryLive,
} from "../../../src/services/startup/BackendRecovery";
import * as families from "../../../src/domain/session-families/sessionFamilies";
import {
  makeSessionFamilyStorageLive,
  SessionFamilyStorage,
} from "../../../src/services/storage/SessionFamilyStorage";
import { makeSessionArchiveStorageLive } from "../../../src/services/storage/SessionArchiveStorageLive";
import { DOCUMENT_VERSION } from "../../../src/services/storage/sessionFamilyDocumentCodec";

it.effect(
  "acquires the shell graph before real family IO finishes, shares recovery, and reconciles once",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-recovery-gate-" });
      const file = `${directory}/families.json`;
      yield* fs.writeFileString(
        file,
        JSON.stringify({
          version: DOCUMENT_VERSION,
          data: {
            families: [],
            spawnedSessions: [],
            turns: [
              {
                sessionId: "orphan",
                senderSessionId: "parent",
                turnId: "turn",
                requestMessageId: "request",
                threadId: "family",
                reported: false,
              },
            ],
          },
        }),
      );
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      let reads = 0;
      let passes = 0;
      const slowFs = FileSystem.makeNoop({
        ...fs,
        readFileString: (path) =>
          path !== file
            ? fs.readFileString(path)
            : Effect.gen(function* () {
                reads++;
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release).pipe(
                  Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
                );
                return yield* fs.readFileString(path);
              }),
      });
      const storage = Layer.mergeAll(
        makeSessionFamilyStorageLive(file),
        makeSessionArchiveStorageLive(`${directory}/archive`, {
          activeRoot: `${directory}/active`,
          resolvedRoot: `${directory}/resolved`,
        }),
      ).pipe(
        Layer.provide(Layer.merge(Layer.succeed(FileSystem.FileSystem, slowFs), NodePath.layer)),
      );
      const layer = makeBackendRecoveryLive(
        families
          .initialize(`${directory}/active`, `${directory}/resolved`, () => Effect.succeed(false))
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                passes++;
              }),
            ),
            Effect.orDie,
          ),
      ).pipe(Layer.provideMerge(storage));
      const owner = yield* Scope.fork(yield* Effect.scope);
      const context = yield* Layer.buildWithScope(layer, owner);
      const gate = Context.get(context, BackendRecovery);
      yield* Deferred.await(entered);
      expect(reads).toBe(1);
      expect(passes).toBe(0);
      const cancelled = yield* gate.awaitReady().pipe(Effect.forkScoped);
      yield* Fiber.interrupt(cancelled);
      expect(yield* Deferred.isDone(interrupted)).toBe(false);
      const waiters = yield* Effect.all([gate.awaitReady(), gate.awaitReady()], {
        concurrency: "unbounded",
      }).pipe(Effect.forkScoped);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(waiters);
      yield* gate.awaitReady();
      expect(passes).toBe(1);
      const stored = yield* Context.get(context, SessionFamilyStorage).state();
      expect(stored.turns[0]?.outcome).toBe("aborted");
      yield* Scope.close(owner, Exit.void);
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);

it.effect("scope shutdown interrupts unfinished recovery and permanently settles its gate", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    const owner = yield* Scope.fork(yield* Effect.scope);
    const context = yield* Layer.buildWithScope(
      makeBackendRecoveryLive(
        Effect.acquireUseRelease(
          Deferred.succeed(entered, undefined),
          () => Effect.never,
          () => Deferred.succeed(finalized, undefined),
        ),
      ),
      owner,
    );
    const gate = Context.get(context, BackendRecovery);
    yield* Deferred.await(entered);
    yield* Scope.close(owner, Exit.void);
    expect(yield* Deferred.isDone(finalized)).toBe(true);
    const exit = yield* gate.awaitReady().pipe(Effect.exit);
    expect(Exit.hasInterrupts(exit)).toBe(true);
  }),
);

it.effect("recovery defects stay visible to every waiter without an unsafe implicit retry", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const layer = makeBackendRecoveryLive(
      Effect.suspend(() => {
        attempts++;
        return Effect.die("reconciliation failed");
      }),
    );
    yield* Effect.gen(function* () {
      const gate = yield* BackendRecovery;
      for (let i = 0; i < 2; i++) {
        const exit = yield* gate.awaitReady().pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) expect(String(exit.cause)).toContain("reconciliation failed");
      }
      expect(attempts).toBe(1);
    }).pipe(Effect.provide(layer));
  }),
);
