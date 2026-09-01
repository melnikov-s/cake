import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Ref, Scope, Stream } from "effect";
import { describe } from "vitest";
import {
  makePiSessionsLayer,
  PiSessions,
  type PiSessionAcquireOptions,
  type PiSessionsAdapter,
} from "../../../../src/services/pi/PiSessions";
import type {
  CakeRuntime,
  CakeRuntimeOptions,
} from "../../../../src/services/pi/runtime/cake-runtime";
import type { SessionSnapshot } from "../../../../src/ipc/session-contract";

const snapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "session-1",
  sessionFile: "/sessions/session-1.jsonl",
  parts: [],
  models: [],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  sessions: [],
  tree: [],
};

const options = (overrides: Partial<PiSessionAcquireOptions["runtime"]> = {}) =>
  ({
    profile: { _tag: "ProjectSession" },
    runtime: {
      cwd: "/project",
      trusted: true,
      agentDir: "/agent",
      sessionDir: "/sessions",
      sessionId: "session-1",
      requestUi: async () => undefined,
      ...overrides,
    },
  }) satisfies PiSessionAcquireOptions;

function fakeRuntime(
  runtimeOptions: CakeRuntimeOptions,
  onDispose: () => void | Promise<void>,
): CakeRuntime {
  return {
    sessionId: snapshot.sessionId,
    sessionFile: snapshot.sessionFile,
    snapshot: async () => {
      runtimeOptions.onEvent({
        type: "streaming",
        sessionId: snapshot.sessionId,
        streaming: true,
      });
      return snapshot;
    },
    prompt: async () => undefined,
    compact: async () => undefined,
    abort: async () => undefined,
    setModel: async () => undefined,
    setThinkingLevel: async () => undefined,
    applyConfiguration: async () => undefined,
    setPiSetting: async () => undefined,
    recordReviewRun: () => undefined,
    login: async () => undefined,
    logout: async () => undefined,
    rename: async () => undefined,
    fork: async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" }),
    handoff: async () => ({ sessionId: "handoff", sessionFile: "/sessions/handoff.jsonl" }),
    navigate: async () => undefined,
    dispose: onDispose,
  };
}

const adapter = (
  acquisitions: Ref.Ref<number>,
  finalizations: Ref.Ref<number>,
): PiSessionsAdapter => ({
  list: () => Effect.succeed([]),
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

describe("PiSessions", () => {
  it.effect("shares one keyed runtime and finalizes it after the last Scope releases", () =>
    Effect.gen(function* () {
      const acquisitions = yield* Ref.make(0);
      const finalizations = yield* Ref.make(0);
      const context = yield* Layer.build(makePiSessionsLayer(adapter(acquisitions, finalizations)));
      const sessions = Context.get(context, PiSessions);
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
      const context = yield* Layer.build(makePiSessionsLayer(adapter(acquisitions, finalizations)));
      const sessions = Context.get(context, PiSessions);
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      const acquireOptions: PiSessionAcquireOptions = {
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
      const context = yield* Layer.build(makePiSessionsLayer(adapter(acquisitions, finalizations)));
      const sessions = Context.get(context, PiSessions);
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

  it.effect("awaits asynchronous runtime finalization after the last Scope releases", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finalizations = yield* Ref.make(0);
      const layer = makePiSessionsLayer({
        list: () => Effect.succeed([]),
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
      const sessions = Context.get(context, PiSessions);
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
      const context = yield* Layer.build(makePiSessionsLayer(adapter(acquisitions, finalizations)));
      const sessions = Context.get(context, PiSessions);
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
      const context = yield* Layer.build(makePiSessionsLayer(adapter(acquisitions, finalizations)));
      const sessions = Context.get(context, PiSessions);
      const handle = yield* sessions.acquire(options());
      const fiber = yield* handle.updates.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      const updates = [...(yield* Fiber.join(fiber))];
      assert.equal(updates[0]?._tag, "Snapshot");
      assert.equal(updates[1]?._tag, "Event");
      if (updates[1]?._tag === "Event") assert.equal(updates[1].event.type, "streaming");
    }),
  );
});
