import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Queue, Ref, Stream, SubscriptionRef } from "effect";
import { describe } from "vitest";
import * as subagents from "../../../src/domain/subagents/subagents";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/domain/application/application-data";
import type { SessionSnapshot } from "../../../src/ipc/session-contract";
import {
  makePiSessionsLayer,
  type PiSessionAcquireOptions,
  type PiSessions,
  type PiSessionsAdapter,
} from "../../../src/services/pi/PiSessions";
import type {
  CakeRuntime,
  CakeRuntimeOptions,
} from "../../../src/services/pi/runtime/cake-runtime";
import { subagentSystemPrompt } from "../../../src/services/pi/runtime/subagent-system-prompt";
import {
  SubagentCoordinator,
  SubagentCoordinatorLive,
} from "../../../src/services/subagents/SubagentCoordinator";
import {
  makeSubagentEnvironmentLayer,
  type SubagentEnvironment,
} from "../../../src/services/subagents/SubagentEnvironment";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";

const applicationValue: ApplicationStateValue = {
  ...defaultApplicationState(),
  trustedProjectPaths: ["/project"],
};

const parentSnapshot: SessionSnapshot = {
  workspacePath: "/project",
  sessionId: "parent",
  sessionFile: "/sessions/parent.jsonl",
  parts: [],
  model: { provider: "test", id: "model", name: "Model" },
  models: [
    {
      provider: "test",
      providerName: "Test",
      id: "model",
      name: "Model",
      reasoning: true,
      availableThinkingLevels: ["off"],
      fastMode: true,
      input: ["text"],
      authenticated: true,
      available: true,
      authTypes: [],
    },
  ],
  thinkingLevel: "off",
  availableThinkingLevels: ["off"],
  streaming: false,
  diagnostics: [],
  commands: [],
  compatibility: { resources: [], diagnostics: [] },
  extensionUi: { statuses: [] },
  tree: [],
};

const applicationLayer = Layer.effect(
  ApplicationState,
  Effect.gen(function* () {
    const projection = yield* SubscriptionRef.make({ revision: 0, state: applicationValue });
    return ApplicationState.of({
      initialize: () => Effect.succeed(applicationValue),
      current: () => SubscriptionRef.get(projection).pipe(Effect.map((value) => value.state)),
      snapshot: () => SubscriptionRef.getUnsafe(projection).state,
      changes: () => SubscriptionRef.changes(projection),
      transact: (transition) =>
        SubscriptionRef.updateAndGetEffect(projection, (current) =>
          transition(current.state).pipe(
            Effect.map((state) => ({ revision: current.revision + 1, state })),
          ),
        ).pipe(Effect.map((value) => value.state)),
    });
  }),
);

interface Fixture {
  readonly layer: Layer.Layer<
    ApplicationState | PiSessions | SubagentCoordinator | SubagentEnvironment
  >;
  readonly parentOptions: PiSessionAcquireOptions;
  readonly childStarted: Queue.Queue<string>;
  readonly childGates: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<void>>>;
  readonly constructions: Ref.Ref<number>;
  readonly constructedOptions: Ref.Ref<ReadonlyArray<CakeRuntimeOptions>>;
  readonly active: Ref.Ref<number>;
  readonly maximumActive: Ref.Ref<number>;
  readonly completions: Ref.Ref<ReadonlyArray<unknown>>;
}

const makeFixture = Effect.fn("SubagentsTest.makeFixture")(function* (): Effect.fn.Return<Fixture> {
  const childStarted = yield* Queue.unbounded<string>();
  const childGates = yield* Ref.make<ReadonlyMap<string, Deferred.Deferred<void>>>(new Map());
  const constructions = yield* Ref.make(0);
  const constructedOptions = yield* Ref.make<ReadonlyArray<CakeRuntimeOptions>>([]);
  const active = yield* Ref.make(0);
  const maximumActive = yield* Ref.make(0);
  const completions = yield* Ref.make<ReadonlyArray<unknown>>([]);

  const runtime = (options: CakeRuntimeOptions): CakeRuntime => {
    const sessionId = options.sessionId ?? "parent";
    const isParent = sessionId.startsWith("parent");
    let streaming = false;
    const snapshot = (): SessionSnapshot => ({
      ...parentSnapshot,
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      streaming,
    });
    return {
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      get streaming() {
        return streaming;
      },
      getReviewParentContext: () => ({
        sessionId,
        sessionFile: `/sessions/${sessionId}.jsonl`,
        systemPrompt: "test",
        activeTools: ["read", "bash", "edit", "write", "cake"],
      }),
      snapshot: async () => snapshot(),
      listQueuedMessages: async () => ({ steering: [], followUp: [] }),
      clearQueue: async () => ({ steering: [], followUp: [] }),
      cancelSteering: async () => ({ steering: [], followUp: [] }),
      prompt: async () => {
        if (isParent) return;
        const gate = Deferred.makeUnsafe<void>();
        await Effect.runPromise(
          Ref.update(childGates, (values) => new Map(values).set(sessionId, gate)),
        );
        const now = await Effect.runPromise(Ref.updateAndGet(active, (count) => count + 1));
        await Effect.runPromise(Ref.update(maximumActive, (maximum) => Math.max(maximum, now)));
        streaming = true;
        await Effect.runPromise(Queue.offer(childStarted, sessionId));
        await Effect.runPromise(Deferred.await(gate));
        streaming = false;
        await Effect.runPromise(Ref.update(active, (count) => count - 1));
        options.onEvent({ type: "streaming", sessionId, streaming: false });
      },
      setUserMessageMarkdown: async () => undefined,
      compact: async () => undefined,
      abort: async () => {
        const gate = (await Effect.runPromise(Ref.get(childGates))).get(sessionId);
        if (gate) await Effect.runPromise(Deferred.succeed(gate, undefined));
      },
      setModel: async () => undefined,
      setThinkingLevel: async () => undefined,
      applyConfiguration: async () => undefined,
      setFastMode: async () => undefined,
      setPiSetting: async () => undefined,
      recordReviewRun: () => undefined,
      notifySubagentCompletion: async (result) => {
        await Effect.runPromise(Ref.update(completions, (values) => [...values, result]));
      },
      login: async () => undefined,
      logout: async () => undefined,
      rename: async () => undefined,
      fork: async () => ({ sessionId: "fork", sessionFile: "/sessions/fork.jsonl" }),
      toolCompact: async () => ({
        sessionId: "toolCompact",
        sessionFile: "/sessions/toolCompact.jsonl",
      }),
      navigate: async () => undefined,
      dispose: () => undefined,
    };
  };

  const adapter: PiSessionsAdapter = {
    catalog: () => Stream.empty,
    catalogEntry: () => Effect.succeed(undefined),
    inspect: () => Effect.succeed(undefined),
    createRuntime: (options) =>
      Ref.update(constructedOptions, (values) => [...values, options]).pipe(
        Effect.andThen(
          Ref.update(
            constructions,
            (count) => count + (options.sessionId?.startsWith("parent") ? 0 : 1),
          ),
        ),
        Effect.as(runtime(options)),
      ),
    changelog: () => Effect.succeed("# Changelog"),
  };
  const layer = Layer.mergeAll(
    applicationLayer,
    makePiSessionsLayer(adapter),
    SubagentCoordinatorLive,
    makeSubagentEnvironmentLayer({
      location: (workingDirectory) =>
        Effect.succeed({
          workingDirectory,
          agentDirectory: "/agent",
          sessionDirectory: "/private-sessions",
          trusted: true,
        }),
    }),
  );
  const parentOptions = {
    profile: { _tag: "ProjectSession" as const },
    runtime: {
      cwd: "/project",
      trusted: true,
      agentDir: "/agent",
      sessionDir: "/sessions",
      sessionId: "parent",
      requestUi: async () => undefined,
    },
  };
  return {
    layer,
    parentOptions,
    childStarted,
    childGates,
    constructions,
    constructedOptions,
    active,
    maximumActive,
    completions,
  };
});

const parent = (
  fixture: Fixture,
  parentSessionId = "parent",
  workingDirectory = "/project",
): subagents.SubagentParentRuntime => ({
  parentSessionId,
  workingDirectory,
  options: {
    ...fixture.parentOptions,
    runtime: {
      ...fixture.parentOptions.runtime,
      cwd: workingDirectory,
      sessionId: parentSessionId,
    },
  },
});

const completeChild = Effect.fn("SubagentsTest.completeChild")(function* (
  fixture: Fixture,
  sessionId: string,
) {
  const gate = (yield* Ref.get(fixture.childGates)).get(sessionId);
  assert.ok(gate);
  yield* Deferred.succeed(gate, undefined);
});

describe("Subagents", () => {
  it.effect("uses one stable public handle without exposing the private Pi Session ID", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Audit the boundary" }, parent(fixture));
        const childSessionId = yield* Queue.take(fixture.childStarted);
        assert.equal(JSON.stringify(receipt).includes(childSessionId), false);
        assert.match(receipt.handleId, /^[0-9a-f-]{36}$/i);
        yield* completeChild(fixture, childSessionId);
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(fixture.constructions), 1);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("repeated waits share one handle, one runtime, and one result", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Inspect callers" }, parent(fixture));
        const childSessionId = yield* Queue.take(fixture.childStarted);
        const first = yield* subagents.wait("parent", receipt.handleId).pipe(Effect.forkChild);
        const second = yield* subagents.wait("parent", receipt.handleId).pipe(Effect.forkChild);
        const coordinator = yield* SubagentCoordinator;
        while (
          (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)?.waiters !==
          2
        )
          yield* Effect.yieldNow;
        yield* completeChild(fixture, childSessionId);
        assert.deepEqual(yield* Fiber.join(first), yield* Fiber.join(second));
        assert.equal(yield* Ref.get(fixture.constructions), 1);
        assert.equal((yield* Ref.get(fixture.completions)).length, 0);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("delivers automatically when the active wait is interrupted before completion", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Background race" }, parent(fixture));
        const childSessionId = yield* Queue.take(fixture.childStarted);
        const waiter = yield* subagents.wait("parent", receipt.handleId).pipe(Effect.forkChild);
        const coordinator = yield* SubagentCoordinator;
        while (
          (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)?.waiters !==
          1
        )
          yield* Effect.yieldNow;
        yield* Fiber.interrupt(waiter);
        yield* completeChild(fixture, childSessionId);
        while ((yield* Ref.get(fixture.completions)).length === 0) yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(fixture.completions)).length, 1);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("automatically delivers an unclaimed background completion exactly once", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        yield* subagents.start({ task: "Background audit" }, parent(fixture));
        const childSessionId = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, childSessionId);
        while ((yield* Ref.get(fixture.completions)).length === 0) yield* Effect.yieldNow;
        assert.equal((yield* Ref.get(fixture.completions)).length, 1);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("preflights an entire parallel batch before constructing a child runtime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const error = yield* Effect.flip(
          subagents.parallel(
            {
              tasks: [
                { task: "Valid", model: { prefer: "current" } },
                {
                  task: "Invalid",
                  model: { prefer: "exact", provider: "missing", modelId: "unknown" },
                },
              ],
            },
            parent(fixture),
          ),
        );
        assert.match(error.message, /missing\/unknown is unknown/);
        assert.equal(yield* Ref.get(fixture.constructions), 0);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("constructs at most four child runtimes per Working Directory", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 6 }, (_, index) => index),
          (index) => subagents.start({ task: `Task ${index + 1}` }, parent(fixture)),
          { concurrency: "unbounded" },
        );
        const firstFour = yield* Effect.forEach([0, 1, 2, 3], () =>
          Queue.take(fixture.childStarted),
        );
        assert.equal(yield* Ref.get(fixture.constructions), 4);
        const [first, second] = firstFour;
        assert.ok(first);
        assert.ok(second);
        yield* completeChild(fixture, first);
        yield* completeChild(fixture, second);
        const fifth = yield* Queue.take(fixture.childStarted);
        const sixth = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, fifth);
        yield* completeChild(fixture, sixth);
        yield* Effect.forEach(firstFour.slice(2), (id) => completeChild(fixture, id), {
          discard: true,
        });
        assert.equal(yield* Ref.get(fixture.maximumActive), 4);
        assert.equal(yield* Ref.get(fixture.constructions), 6);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("cancels queued work before constructing its private runtime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipts = yield* Effect.forEach(
          Array.from({ length: 5 }, (_, index) => index),
          (index) => subagents.start({ task: `Task ${index + 1}` }, parent(fixture)),
          { concurrency: "unbounded" },
        );
        const activeIds = yield* Effect.forEach([0, 1, 2, 3], () =>
          Queue.take(fixture.childStarted),
        );
        const queued = receipts[4];
        assert.ok(queued);
        yield* subagents.abort("parent", queued.handleId);
        yield* Effect.forEach(activeIds, (id) => completeChild(fixture, id), { discard: true });
        yield* Effect.yieldNow;
        assert.equal(yield* Ref.get(fixture.constructions), 4);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("uses independent four-way limits for different Working Directories", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        yield* Effect.forEach(
          Array.from({ length: 4 }, (_, index) => index),
          (index) => subagents.start({ task: `Project task ${index + 1}` }, parent(fixture)),
          { concurrency: "unbounded", discard: true },
        );
        const projectIds = yield* Effect.forEach([0, 1, 2, 3], () =>
          Queue.take(fixture.childStarted),
        );
        yield* subagents.start(
          { task: "Other directory" },
          parent(fixture, "parent-other", "/other"),
        );
        const otherId = yield* Queue.take(fixture.childStarted);
        assert.equal(yield* Ref.get(fixture.constructions), 5);
        yield* Effect.forEach([...projectIds, otherId], (id) => completeChild(fixture, id), {
          discard: true,
        });
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("gives the general subagent shell and file tools without Cake or delegation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Review the boundary" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        const childOptions = (yield* Ref.get(fixture.constructedOptions)).find(
          (options) => options.sessionId === childId,
        );
        assert.ok(childOptions);
        assert.deepEqual(childOptions.tools, ["read", "bash", "edit", "write"]);
        assert.equal(childOptions.agentControl, undefined);
        assert.equal(childOptions.additionalSystemPrompt, undefined);
        assert.equal(childOptions.isolatedSystemPrompt, subagentSystemPrompt());
        yield* completeChild(fixture, childId);
        yield* subagents.wait("parent", receipt.handleId);
        const coordinator = yield* SubagentCoordinator;
        assert.equal(
          (yield* SubscriptionRef.get(coordinator.state)).handles.has(receipt.handleId),
          true,
        );
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("serializes follow-up turns on the stable handle without another runtime", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Initial turn" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, childId);
        while ((yield* Ref.get(fixture.completions)).length === 0) yield* Effect.yieldNow;

        const nextTurn = yield* subagents
          .prompt("parent", receipt.handleId, "Continue", "prompt")
          .pipe(Effect.forkChild);
        assert.equal(yield* Queue.take(fixture.childStarted), childId);
        const conflict = yield* Effect.flip(
          subagents.prompt("parent", receipt.handleId, "Overlap", "follow-up"),
        );
        assert.match(conflict.message, /already has active work/);
        yield* completeChild(fixture, childId);
        const result = yield* Fiber.join(nextTurn);
        assert.equal(JSON.stringify(result).includes(receipt.handleId), true);
        assert.equal(yield* Ref.get(fixture.constructions), 1);
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("does not rewrite a completed result when its parent aborts", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Keep this result" }, parent(fixture));
        const childId = yield* Queue.take(fixture.childStarted);
        yield* completeChild(fixture, childId);
        while ((yield* Ref.get(fixture.completions)).length === 0) yield* Effect.yieldNow;
        yield* subagents.abortParentChildren("parent");
        const coordinator = yield* SubagentCoordinator;
        assert.equal(
          (yield* SubscriptionRef.get(coordinator.state)).handles.get(receipt.handleId)?.status,
          "complete",
        );
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("reconnect observation starts with the parent's current live handles", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Observe me" }, parent(fixture));
        yield* Queue.take(fixture.childStarted);
        const updates = yield* subagents.observe("parent");
        const first = yield* Stream.runHead(updates);
        assert.equal(first._tag, "Some");
        if (first._tag === "Some") {
          assert.equal(first.value._tag, "Snapshot");
          if (first.value._tag === "Snapshot")
            assert.deepEqual(
              first.value.activities.map((activity) => activity.handleId),
              [receipt.handleId],
            );
        }
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("parent release closes subagents", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Persistent child" }, parent(fixture));
        yield* Queue.take(fixture.childStarted);
        yield* subagents.releaseParent("parent");
        const coordinator = yield* SubagentCoordinator;
        assert.equal(
          (yield* SubscriptionRef.get(coordinator.state)).handles.has(receipt.handleId),
          false,
        );
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );

  it.effect("rejects a handle owned by another parent", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const program = Effect.gen(function* () {
        const receipt = yield* subagents.start({ task: "Audit" }, parent(fixture));
        const error = yield* Effect.flip(subagents.wait("another-parent", receipt.handleId));
        assert.equal(error._tag, "SubagentError");
        assert.match(error.message, /does not belong/);
        yield* subagents.close("parent", receipt.handleId);
      });
      yield* program.pipe(Effect.provide(fixture.layer));
    }),
  );
});
