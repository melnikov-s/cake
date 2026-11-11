import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Queue, Ref, Scope, Semaphore, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";
import * as subagentTitles from "../../../src/domain/subagents/subagentTitles";
import {
  SubagentHandleId,
  type SubagentError,
  type SubagentResult,
} from "../../../src/contracts/subagents/subagent-data";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { PiModelCompletionError } from "../../../src/contracts/pi/model-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { PiModels } from "../../../src/services/pi/PiModels";
import {
  SubagentCoordinator,
  SubagentCoordinatorLive,
  activityOf,
  type SubagentHandleState,
} from "../../../src/services/subagents/SubagentCoordinator";
import type { SubagentRecord } from "../../../src/services/storage/SubagentStorage";
import {
  makeSubagentStorageTestLayer,
  subagentHistoryFixture,
} from "../helpers/subagentStorageFixture";

const handleId = SubagentHandleId.make("00000000-0000-4000-8000-0000000000aa");
const longTask = `Read-only investigation.\n\n${"Trace every caller of the Activity row. ".repeat(200)}FINAL-SENTINEL`;
const utilityModel = {
  provider: "configured-provider",
  modelId: "configured-utility",
  thinkingLevel: "low" as const,
};
const application = (configured = true) =>
  Layer.mock(ApplicationState, {
    snapshot: () => ({ ...defaultApplicationState(), ...(configured ? { utilityModel } : null) }),
  });

const recovery = (title?: string): SubagentRecord => ({
  handleId,
  privateSessionId: "10000000-0000-4000-8000-0000000000aa",
  parentSessionId: "parent",
  parentProfile: "ProjectSession",
  parentWorkingDirectory: "/project",
  parentSessionDirectory: "/sessions",
  anchorPartId: "tool-start",
  workingDirectory: "/project",
  task: longTask,
  ...(title ? { title } : null),
  allowMutations: false,
  resolvedModel: {
    requested: "current",
    source: "current",
    provider: "test",
    modelId: "model",
    thinkingLevel: "off",
    fallbacks: [],
  },
  fastMode: false,
  tools: [],
  inputReferences: [],
  messageReferences: [],
  notifyOnCompletion: false,
  completionId: "completion",
  completionDisposition: "waited",
  status: "running",
  pendingInputs: [],
});

/** A live worker as admission leaves it, minus a Pi runtime (naming never touches one). */
const insert = (title?: string) =>
  Effect.gen(function* () {
    const coordinator = yield* SubagentCoordinator;
    const saved = recovery(title);
    const handle: SubagentHandleState = {
      handleId,
      recovery: saved,
      parentSessionId: saved.parentSessionId,
      anchorPartId: saved.anchorPartId,
      workingDirectory: saved.workingDirectory,
      task: saved.task,
      resolvedModel: saved.resolvedModel,
      tools: [],
      fastMode: false,
      // Coordinator shutdown closes each live handle's scope.
      scope: yield* Scope.make(),
      inputAdmission: yield* Semaphore.make(1),
      completion: yield* Deferred.make<SubagentResult, SubagentError>(),
      runtimeOptions: {
        profile: { _tag: "ProjectSession" },
        runtime: {
          cwd: "/project",
          agentDir: "/agent",
          sessionDir: "/private-sessions",
          requestUi: async () => undefined,
        },
      },
      inputReferences: [],
      messageReferences: [],
      status: "running",
      activityRevision: 0,
      streaming: true,
      parts: [],
      waiters: 0,
      completionDisposition: "waited",
    };
    yield* SubscriptionRef.update(coordinator.state, (state) => ({
      revision: state.revision + 1,
      handles: new Map(state.handles).set(handleId, handle),
    }));
  });

const currentHandle = Effect.gen(function* () {
  const coordinator = yield* SubagentCoordinator;
  return (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
});

const layer = (complete: PiModels["Service"]["complete"], configured = true) =>
  Layer.mergeAll(
    SubagentCoordinatorLive.pipe(Layer.provide(makeSubagentStorageTestLayer())),
    application(configured),
    Layer.mock(PiModels, { complete }),
  );

describe("subagent utility naming", () => {
  it.effect("names a worker once from its trimmed task and persists the title for restart", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([]);
      yield* Effect.gen(function* () {
        yield* insert();
        yield* subagentTitles.assign(handleId);
        const named = yield* currentHandle;
        expect(named?.recovery.title).toBe("Trace Activity row callers");
        // Renderers receive it through the activity projection.
        expect(activityOf(named!).title).toBe("Trace Activity row callers");
        expect(activityOf(named!).task).toBe(longTask);
        const saved = yield* (yield* SubagentCoordinator).storage.get(handleId);
        expect(saved?.title).toBe("Trace Activity row callers");
        // Re-requesting (e.g. a duplicate offer) never calls the model again.
        yield* subagentTitles.assign(handleId);
        expect(yield* Ref.get(calls)).toHaveLength(1);
        const [context] = yield* Ref.get(calls);
        expect(context).toContain("Read-only investigation. Trace every caller");
        expect(context).not.toContain("\n\n");
        expect(context).not.toContain("FINAL-SENTINEL");
        expect(context!.length).toBeLessThan(subagentTitles.SUBAGENT_TITLE_SOURCE_CHARACTERS + 100);
      }).pipe(
        Effect.provide(
          layer((input) =>
            Ref.update(calls, (all) => [...all, input.context]).pipe(
              Effect.as('"Trace Activity row callers."'),
            ),
          ),
        ),
      );
    }),
  );

  it.effect("keeps a saved title after restart without calling the utility model", () =>
    Effect.gen(function* () {
      yield* insert("Saved title");
      yield* subagentTitles.assign(handleId);
      expect((yield* currentHandle)?.recovery.title).toBe("Saved title");
    }).pipe(Effect.provide(layer(() => Effect.die("The utility model must not be called again")))),
  );

  it.effect("leaves the task preview in place when no utility model is configured", () =>
    Effect.gen(function* () {
      yield* insert();
      yield* subagentTitles.assign(handleId);
      expect((yield* currentHandle)?.recovery.title).toBeUndefined();
    }).pipe(Effect.provide(layer(() => Effect.die("Naming is disabled"), false))),
  );

  it.effect("keeps the task preview when naming fails, after the pipeline's single retry", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const retried = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* insert();
        yield* subagentTitles.initialize();
        const coordinator = yield* SubagentCoordinator;
        yield* Queue.offer(coordinator.titleRequests, handleId);
        yield* Deferred.await(retried);
        yield* Effect.yieldNow;
        expect((yield* currentHandle)?.recovery.title).toBeUndefined();
        expect((yield* coordinator.storage.get(handleId))?.title).toBeUndefined();
        expect(yield* Ref.get(attempts)).toBe(2);
      }).pipe(
        Effect.provide(
          layer(() =>
            Ref.updateAndGet(attempts, (count) => count + 1).pipe(
              Effect.tap((count) =>
                count === 2 ? Deferred.succeed(retried, undefined) : Effect.void,
              ),
              Effect.andThen(Effect.fail(new PiModelCompletionError({ message: "Unavailable" }))),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("labels the history record when the worker is released while naming", () => {
    let release: Effect.Effect<void> = Effect.void;
    return Effect.gen(function* () {
      const coordinator = yield* SubagentCoordinator;
      // Release drops the live handle before the model answers.
      release = SubscriptionRef.update(coordinator.state, (state) => ({
        revision: state.revision + 1,
        handles: new Map(),
      }));
      yield* insert();
      yield* coordinator.storage.history.update(subagentHistoryFixture({ handleId }));
      yield* subagentTitles.assign(handleId);
      expect((yield* coordinator.storage.history.get(handleId))?.title).toBe("Late title");
    }).pipe(
      Effect.provide(layer(() => Effect.suspend(() => release).pipe(Effect.as("Late title")))),
    );
  });
});
