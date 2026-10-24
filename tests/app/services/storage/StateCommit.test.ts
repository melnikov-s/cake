import { NodeFileSystem } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Path,
  PlatformError,
  Queue,
  Ref,
  Stream,
  type Scope,
} from "effect";
import { describe, expect } from "vitest";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationValue,
} from "../../../../src/contracts/application/application-data";
import type { ScheduledMessage } from "../../../../src/contracts/scheduled-messages/scheduled-message-data";
import { ScheduledMessages } from "../../../../src/services/scheduled-messages/ScheduledMessages";
import { ApplicationState } from "../../../../src/services/storage/ApplicationState";
import {
  APPLICATION_DOCUMENT_NAME,
  ApplicationStorage,
  makeApplicationStorageLive,
} from "../../../../src/services/storage/ApplicationStorage";
import {
  makeScheduledMessageStorageLive,
  ScheduledMessageStorage,
} from "../../../../src/services/storage/ScheduledMessageStorage";

type Snapshot<A> = { readonly revision: number; readonly value: A };
interface CommitState<A> {
  readonly snapshot: () => A;
  readonly changes: () => Stream.Stream<Snapshot<A>>;
  readonly transact: <E>(
    transition: (current: A) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, unknown>;
  readonly load: () => Effect.Effect<A, unknown>;
  readonly document: string;
}

const makeFileSystem = Effect.fn("StateCommitTest.makeFileSystem")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-state-commit-" });
  const mode = yield* Ref.make<"normal" | "cleanup" | "rename-failure">("normal");
  const cleanupStarted = yield* Deferred.make<void>();
  const releaseCleanup = yield* Deferred.make<void>();
  const fileSystem: FileSystem.FileSystem = {
    ...fs,
    rename: Effect.fn("StateCommitTest.rename")(function* (source, target) {
      if ((yield* Ref.get(mode)) === "rename-failure") {
        return yield* PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "StateCommitTest",
          method: "rename",
        });
      }
      yield* fs.rename(source, target);
    }),
    remove: Effect.fn("StateCommitTest.remove")(function* (path, options) {
      // atomicWriteFile has already renamed the real temporary file at this point.
      if (path.endsWith(".tmp") && (yield* Ref.get(mode)) === "cleanup") {
        yield* Deferred.succeed(cleanupStarted, undefined);
        yield* Deferred.await(releaseCleanup);
      }
      yield* fs.remove(path, options);
    }),
  };
  return { directory, fileSystem, mode, cleanupStarted, releaseCleanup };
});

const makeApplication = Effect.fn("StateCommitTest.makeApplication")(function* (
  directory: string,
  fs: FileSystem.FileSystem,
): Effect.fn.Return<CommitState<ApplicationValue>, unknown, Scope.Scope> {
  const context = yield* Layer.build(
    ApplicationState.layer.pipe(
      Layer.provideMerge(makeApplicationStorageLive(directory)),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
      Layer.provide(Path.layer),
    ),
  );
  const state = Context.get(context, ApplicationState);
  const storage = Context.get(context, ApplicationStorage);
  yield* storage.save(defaultApplicationState());
  yield* state.initialize();
  return {
    snapshot: () => state.snapshot(),
    changes: () =>
      state.changes().pipe(Stream.map(({ revision, state }) => ({ revision, value: state }))),
    transact: (transition) => state.transact(transition),
    load: () => storage.load().pipe(Effect.map(({ state }) => state)),
    document: `${directory}/${APPLICATION_DOCUMENT_NAME}`,
  };
});

const makeScheduled = Effect.fn("StateCommitTest.makeScheduled")(function* (
  directory: string,
  fs: FileSystem.FileSystem,
): Effect.fn.Return<CommitState<ReadonlyArray<ScheduledMessage>>, unknown, Scope.Scope> {
  const context = yield* Layer.build(
    ScheduledMessages.layer.pipe(
      Layer.provideMerge(makeScheduledMessageStorageLive(directory)),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, fs)),
      Layer.provide(Path.layer),
    ),
  );
  const state = Context.get(context, ScheduledMessages);
  const storage = Context.get(context, ScheduledMessageStorage);
  yield* storage.save([]);
  yield* state.initialize();
  return {
    snapshot: () => state.snapshot().messages,
    changes: () =>
      state.changes().pipe(Stream.map(({ revision, messages }) => ({ revision, value: messages }))),
    transact: (transition) =>
      state.transact(transition).pipe(Effect.map(({ messages }) => messages)),
    load: () => storage.load(),
    document: `${directory}/scheduled-messages.json`,
  };
});

// Run the same commit laws against both real storage/projection pairs. Only the
// filesystem's cleanup gate and pre-rename refusal are controlled by the test.
const commitTests = <A>(
  name: string,
  makeState: (
    directory: string,
    fs: FileSystem.FileSystem,
  ) => Effect.Effect<CommitState<A>, unknown, Scope.Scope>,
  first: (value: A) => A,
  unrelated: (value: A) => A,
) => {
  const withState = <B, E, R>(
    use: (
      state: CommitState<A>,
      fs: Effect.Success<ReturnType<typeof makeFileSystem>>,
    ) => Effect.Effect<B, E, R>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* makeFileSystem();
      const state = yield* makeState(fs.directory, fs.fileSystem);
      return yield* use(state, fs);
    }).pipe(Effect.provide(NodeFileSystem.layer));

  describe(name, () => {
    it.effect(
      "cancellation during atomic-write cleanup publishes the committed value; a subsequent unrelated transaction preserves it",
      () =>
        withState((state, fs) =>
          Effect.gen(function* () {
            const initial = state.snapshot();
            const committed = first(initial);
            const updates = yield* Queue.unbounded<Snapshot<A>>();
            yield* state.changes().pipe(
              Stream.runForEach((update) => Queue.offer(updates, update)),
              Effect.forkScoped,
            );
            const beforePublication = yield* Queue.take(updates);
            expect(beforePublication.value).toEqual(initial);
            yield* Ref.set(fs.mode, "cleanup");
            const mutation = yield* state
              .transact(() => Effect.succeed(committed))
              .pipe(Effect.forkScoped);
            yield* Deferred.await(fs.cleanupStarted);
            // Read the real file directly: storage.load is serialized behind this save.
            expect(JSON.parse(yield* fs.fileSystem.readFileString(state.document))).toMatchObject({
              data: committed,
            });
            expect(state.snapshot()).toEqual(initial);
            // Request synchronously before opening the finalizer gate; Fiber.interrupt
            // would wait for that gate and deadlock the test.
            yield* Effect.sync(() => mutation.interruptUnsafe(123));
            yield* Deferred.succeed(fs.releaseCleanup, undefined);
            const exit = yield* Fiber.await(mutation);
            expect(Exit.hasInterrupts(exit)).toBe(true);
            expect(state.snapshot()).toEqual(committed);
            const published = yield* Queue.take(updates);
            expect(published).toEqual({
              revision: beforePublication.revision + 1,
              value: committed,
            });
            expect(yield* state.load()).toEqual(committed);
            yield* Ref.set(fs.mode, "normal");
            yield* state.transact((value) => Effect.succeed(unrelated(value)));
            expect(yield* state.load()).toEqual(unrelated(committed));
            expect(state.snapshot()).toEqual(unrelated(committed));
            expect(yield* Queue.take(updates)).toEqual({
              revision: published.revision + 1,
              value: unrelated(committed),
            });
          }).pipe(Effect.ensuring(Deferred.succeed(fs.releaseCleanup, undefined))),
        ),
    );

    it.effect("precommit failure publishes nothing and leaves the durable value unchanged", () =>
      withState((state, fs) =>
        Effect.gen(function* () {
          const initial = state.snapshot();
          const updates = yield* Queue.unbounded<Snapshot<A>>();
          yield* state.changes().pipe(
            Stream.runForEach((update) => Queue.offer(updates, update)),
            Effect.forkScoped,
          );
          const before = yield* Queue.take(updates);
          yield* Ref.set(fs.mode, "rename-failure");
          const failure = yield* state
            .transact((value) => Effect.succeed(first(value)))
            .pipe(Effect.flip);
          expect(failure).toMatchObject(
            name === "ApplicationState"
              ? { _tag: "ApplicationWriteError", stage: "rename" }
              : { _tag: "ScheduledMessageStorageError", operation: "rename" },
          );
          expect(yield* state.load()).toEqual(initial);
          expect(state.snapshot()).toEqual(initial);
          yield* Ref.set(fs.mode, "normal");
          yield* state.transact((value) => Effect.succeed(unrelated(value)));
          // The next observed revision proves there was no failed publication.
          expect(yield* Queue.take(updates)).toEqual({
            revision: before.revision + 1,
            value: unrelated(initial),
          });
          expect(yield* state.load()).toEqual(unrelated(initial));
        }),
      ),
    );

    it.effect("serialization of concurrent mutations preserves both changes", () =>
      withState((state) =>
        Effect.gen(function* () {
          const initial = state.snapshot();
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const firstMutation = yield* state
            .transact((value) =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(first(value)),
              ),
            )
            .pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          const secondEntered = yield* Ref.make(false);
          const secondMutation = yield* state
            .transact((value) => Ref.set(secondEntered, true).pipe(Effect.as(unrelated(value))))
            .pipe(Effect.forkScoped({ startImmediately: true }));
          expect(yield* Ref.get(secondEntered)).toBe(false);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(firstMutation);
          yield* Fiber.join(secondMutation);
          expect(state.snapshot()).toEqual(unrelated(first(initial)));
          expect(yield* state.load()).toEqual(unrelated(first(initial)));
        }),
      ),
    );

    it.effect(
      "cancelling a user transition or a waiting mutation remains interruptible and publishes nothing",
      () =>
        withState((state) =>
          Effect.gen(function* () {
            const initial = state.snapshot();
            const entered = yield* Deferred.make<void>();
            const transition = yield* state
              .transact(() =>
                Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
              )
              .pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            const waiting = yield* state
              .transact((value) => Effect.succeed(first(value)))
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Fiber.interrupt(waiting);
            expect(Exit.hasInterrupts(yield* Fiber.await(waiting))).toBe(true);
            yield* Fiber.interrupt(transition);
            expect(Exit.hasInterrupts(yield* Fiber.await(transition))).toBe(true);
            expect(state.snapshot()).toEqual(initial);
            expect(yield* state.load()).toEqual(initial);
            yield* state.transact((value) => Effect.succeed(unrelated(value)));
            expect(yield* state.load()).toEqual(unrelated(initial));
          }),
        ),
    );
  });
};

commitTests(
  "ApplicationState",
  makeApplication,
  (value) => ({ ...value, globalCustomInstructions: "committed instructions" }),
  (value) => ({ ...value, unreadSessionIds: ["unrelated-session"] }),
);

it.effect(
  "slow transaction diagnostics distinguish lock wait, transition and persisted publication",
  () => {
    let nanos = 0n;
    let saves = 0;
    const messages: unknown[] = [];
    return Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const saving = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const storage = Layer.succeed(ApplicationStorage, {
        load: () =>
          Effect.succeed({ state: defaultApplicationState(), source: "current" as const }),
        save: () =>
          Effect.gen(function* () {
            saves++;
            if (saves === 1) {
              yield* Deferred.succeed(saving, undefined);
              yield* Deferred.await(release);
            }
          }),
      });
      const services = yield* Layer.build(ApplicationState.layer.pipe(Layer.provide(storage)));
      const state = Context.get(services, ApplicationState);
      yield* Effect.gen(function* () {
        const first = yield* state
          .transact((value) =>
            Effect.sync(() => {
              nanos += 2_000_000_000n;
              return { ...value, globalCustomInstructions: "PRIVATE_STATE" };
            }),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(saving);
        // A real persistence dependency still serializes mutations. Timing it must not
        // weaken disk-before-publication or make the next edit overwrite the first.
        const second = yield* state
          .transact((value) =>
            Effect.succeed({
              ...value,
              unreadSessionIds: ["PRIVATE_SESSION"],
            }),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        expect(state.snapshot().globalCustomInstructions).not.toBe("PRIVATE_STATE");
        nanos += 3_000_000_000n;
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        expect(state.snapshot()).toMatchObject({
          globalCustomInstructions: "PRIVATE_STATE",
          unreadSessionIds: ["PRIVATE_SESSION"],
        });
      }).pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          monotonicTimeNanosUnsafe: () => nanos,
          monotonicTimeNanos: Effect.sync(() => nanos),
        }),
      );
      expect(messages).toEqual(
        expect.arrayContaining([
          [
            "Slow application transaction",
            {
              completed: true,
              phase: "publish",
              phasesMs: { wait: 0, transition: 2_000, persist: 3_000, publish: 0 },
              totalMs: 5_000,
            },
          ],
          [
            "Slow application transaction",
            {
              completed: true,
              phase: "publish",
              phasesMs: { wait: 3_000, transition: 0, persist: 0, publish: 0 },
              totalMs: 3_000,
            },
          ],
        ]),
      );
      expect(messages).toHaveLength(2);
      expect(JSON.stringify(messages)).not.toContain("PRIVATE");
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            messages.push(message);
          }),
        ]),
      ),
    );
  },
);

const late: ScheduledMessage = {
  id: "00000000-0000-4000-8000-000000000001",
  targetSessionId: "session-1",
  text: "Later message",
  sendAt: "2030-01-01T12:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const early: ScheduledMessage = {
  ...late,
  id: "00000000-0000-4000-8000-000000000002",
  text: "Earlier message",
  sendAt: "2030-01-01T11:00:00.000Z",
};
commitTests(
  "ScheduledMessages",
  makeScheduled,
  (value) => [...value, late],
  (value) => [early, ...value],
);
