import { it } from "@effect/vitest";
import { Deferred, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";
import {
  type WorktreeLandingError,
  type WorktreeLandingPhase,
  WorktreeLandingSnapshot,
} from "../../../src/domain/worktree-landing-data";
import { WorktreeOperationCatalogUpdate } from "../../../src/domain/worktree-operation-data";
import type { WorktreeRecord } from "../../../src/domain/managed-worktree-data";
import * as worktreeLandings from "../../../src/domain/worktreeLandings";
import type { WorktreeLandOutcome, WorktreeStatus } from "../../../src/ipc/worktree-contract";
import {
  WorktreeLandingAgent,
  WorktreeLandingAgentError,
} from "../../../src/services/worktrees/WorktreeLandingAgent";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../../src/services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingCompletion } from "../../../src/services/worktrees/WorktreeLandingCompletion";
import {
  ManagedWorktreeError,
  ManagedWorktrees,
} from "../../../src/services/worktrees/ManagedWorktrees";

const workspacePath = "/worktree";
const record = {
  projectPath: "/project",
  worktreePath: workspacePath,
  branch: "agent/change",
  baseBranch: "main",
  createdAt: new Date(0).toISOString(),
  state: "active" as const,
};

const baseStatus = (): WorktreeStatus => ({
  record,
  targetBranch: "main",
  dirtyCount: 0,
  aheadCount: 1,
  behindCount: 0,
  merged: false,
  targetDirty: false,
  targetOnBranch: true,
  merging: false,
  rebasing: false,
  squashMessageReady: false,
});

const failure = (operation: string) =>
  new ManagedWorktreeError({ operation, message: `Unexpected ${operation}` });

function services(options: {
  status: () => WorktreeStatus | undefined;
  records?: () => ReadonlyArray<WorktreeRecord>;
  events: string[];
  land?: () => WorktreeLandOutcome;
  prompt?: (text: string) => void;
  promptWait?: Effect.Effect<void>;
  prepare?: Effect.Effect<void, ManagedWorktreeError>;
  cancel?: (onlyIfQueued: boolean | undefined) => Effect.Effect<void, ManagedWorktreeError>;
  resolve?: (workingDirectory: string) => Effect.Effect<
    {
      projectPath: string;
      workingDirectory: string;
      resolvedSessionIds: string[];
      failures: Array<{ sessionIds: string[]; message: string }>;
    },
    WorktreeLandingError
  >;
}) {
  const managed = ManagedWorktrees.of({
    records: () => Effect.succeed(options.records?.() ?? [record]),
    observe: () => Stream.never,
    create: () => Effect.fail(failure("create")),
    status: () => Effect.sync(options.status),
    setResolveAfterLanding: (_worktreePath, enabled) =>
      Effect.sync(() => options.events.push(`resolve-intent:${enabled}`)),
    prepareLanding: () =>
      Effect.sync(() => options.events.push("prepare")).pipe(
        Effect.andThen(options.prepare ?? Effect.void),
      ),
    land: () =>
      Effect.sync(() => {
        options.events.push("land");
        return options.land?.() ?? ({ outcome: "landed" } as const);
      }),
    cancelLanding: (_workspacePath, _operationId, onlyIfQueued) =>
      options.cancel?.(onlyIfQueued) ?? Effect.sync(() => void options.events.push("cancel")),
    rebase: () => Effect.fail(failure("rebase")),
    discard: () => Effect.fail(failure("discard")),
    cleanupResolved: () => Effect.fail(failure("cleanupResolved")),
    restoreResolved: () => Effect.fail(failure("restoreResolved")),
    proposeSquashMessage: () => Effect.fail(failure("proposeSquashMessage")),
  });
  const agent = WorktreeLandingAgent.of({
    promptAndWait: ({ text }) =>
      Effect.sync(() => {
        options.events.push("prompt");
        options.prompt?.(text);
      }).pipe(
        Effect.andThen(options.promptWait ?? Effect.void),
        Effect.mapError(
          () => new WorktreeLandingAgentError({ operation: "prompt", message: "failed" }),
        ),
      ),
  });
  return Layer.mergeAll(
    Layer.succeed(ManagedWorktrees, managed),
    Layer.succeed(WorktreeLandingAgent, agent),
    WorktreeLandingCoordinatorLive,
    Layer.succeed(
      WorktreeLandingCompletion,
      WorktreeLandingCompletion.of({
        resolveWorkingDirectory: (workingDirectory) =>
          options.resolve?.(workingDirectory) ??
          Effect.succeed({
            projectPath: "/project",
            workingDirectory,
            resolvedSessionIds: [],
            failures: [],
          }),
      }),
    ),
  );
}

const awaitPhase = (phase: WorktreeLandingPhase) =>
  Effect.gen(function* () {
    const coordinator = yield* WorktreeLandingCoordinator;
    return yield* SubscriptionRef.changes(coordinator.state).pipe(
      Stream.map((state) => state.operations.get(workspacePath)),
      Stream.filter((operation) => operation?.phase === phase),
      Stream.runHead,
    );
  });

describe("WorktreeLandings", () => {
  it.effect("reserves, asks the Project Session to commit, then lands", () => {
    const events: string[] = [];
    let status = { ...baseStatus(), dirtyCount: 2, aheadCount: 0 };
    let promptText = "";
    const layer = services({
      status: () => status,
      events,
      prompt: (text) => {
        promptText = text;
        status = baseStatus();
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* worktreeLandings.start({
          operationId: "landing-1",
          workspacePath,
          sessionId: "session-1",
          strategy: "preserve",
          allowDirtyTarget: false,
          commitBeforeLanding: true,
        });
        yield* awaitPhase("landed");
        expect(events).toEqual(["prepare", "prompt", "land"]);
        expect(promptText).toContain("commit all intended work");
        expect(promptText).toContain("Do not merge, rebase, push");
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("owns conflict prompting and automatically retries a resolved landing", () => {
    const events: string[] = [];
    let attempts = 0;
    let promptText = "";
    const layer = services({
      status: baseStatus,
      events,
      land: () =>
        ++attempts === 1 ? { outcome: "resolving", files: ["shared.ts"] } : { outcome: "landed" },
      prompt: (text) => {
        promptText = text;
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* worktreeLandings.start({
          operationId: "landing-2",
          workspacePath,
          sessionId: "session-1",
          strategy: "preserve",
          allowDirtyTarget: false,
          commitBeforeLanding: false,
        });
        yield* awaitPhase("landed");
        expect(events).toEqual(["prepare", "land", "prompt", "land"]);
        expect(promptText).toContain("shared.ts");
        expect(promptText).toContain("Cake will finish the landing");
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("pauses incomplete agent work and retries only on an explicit request", () => {
    const events: string[] = [];
    let status = { ...baseStatus(), dirtyCount: 1, aheadCount: 0 };
    let prompts = 0;
    const layer = services({
      status: () => status,
      events,
      prompt: () => {
        prompts += 1;
        if (prompts === 2) status = baseStatus();
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* worktreeLandings.start({
          operationId: "landing-3",
          workspacePath,
          sessionId: "session-1",
          strategy: "preserve",
          allowDirtyTarget: false,
          commitBeforeLanding: true,
        });
        yield* awaitPhase("stalled");
        expect(events).toEqual(["prepare", "prompt"]);
        yield* worktreeLandings.retry({ workspacePath, sessionId: "session-1" });
        yield* awaitPhase("landed");
        expect(events).toEqual(["prepare", "prompt", "prompt", "land"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("adopts durable paused metadata and resumes ready work after process recovery", () => {
    const events: string[] = [];
    const layer = services({
      status: () => ({
        ...baseStatus(),
        landingOperationId: "recovered-landing",
        record: { ...record, pendingStrategy: "preserve" },
      }),
      events,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
        expect(snapshot.operation?.operationId).toBe("recovered-landing");
        yield* awaitPhase("landed");
        expect(events).toEqual(["prepare", "land"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("reacquires the FIFO reservation for durable paused landing metadata", () => {
    const events: string[] = [];
    const layer = services({
      status: () => ({
        ...baseStatus(),
        dirtyCount: 1,
        rebasing: true,
        landingOperationId: "recovered-conflict",
        record: { ...record, pendingStrategy: "preserve" },
      }),
      events,
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const snapshot = yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
        expect(snapshot.operation?.phase).toBe("waiting");
        yield* awaitPhase("stalled");
        expect(events).toEqual(["prepare"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("atomically claims a paused operation before retrying", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const promptGate = yield* Deferred.make<void>();
        const layer = services({
          status: baseStatus,
          events,
          promptWait: Deferred.await(promptGate),
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* WorktreeLandingCoordinator;
          yield* SubscriptionRef.update(coordinator.state, () => ({
            operations: new Map([
              [
                workspacePath,
                {
                  operationId: "paused-landing",
                  workspacePath,
                  sessionId: "session-1",
                  kind: "landing" as const,
                  phase: "stalled" as const,
                  strategy: "preserve" as const,
                  allowDirtyTarget: false,
                  pauseReason: "conflict" as const,
                },
              ],
            ]),
          }));
          yield* worktreeLandings.retry({ workspacePath, sessionId: "session-1" });
          yield* awaitPhase("resolving");
          yield* worktreeLandings.retry({ workspacePath, sessionId: "session-2" }).pipe(
            Effect.flip,
            Effect.map((error) => expect(error.operation).toBe("retry")),
          );
          yield* Deferred.succeed(promptGate, undefined);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("rejects cancellation once a merge is no longer authoritatively queued", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const layer = services({
          status: baseStatus,
          events,
          cancel: (onlyIfQueued) =>
            onlyIfQueued
              ? Effect.fail(
                  new ManagedWorktreeError({
                    operation: "cancelLanding",
                    message: "This merge has already started and cannot be canceled.",
                  }),
                )
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* WorktreeLandingCoordinator;
          yield* SubscriptionRef.update(coordinator.state, () => ({
            operations: new Map([
              [
                workspacePath,
                {
                  operationId: "landing-started",
                  workspacePath,
                  sessionId: "session-1",
                  kind: "landing" as const,
                  phase: "waiting" as const,
                  strategy: "preserve" as const,
                  allowDirtyTarget: false,
                },
              ],
            ]),
          }));
          const error = yield* worktreeLandings
            .cancel(workspacePath, "landing-started")
            .pipe(Effect.flip);
          expect(error.operation).toBe("cancel");
          expect(error.message).toMatch(/already started/i);
          expect(events).toEqual([]);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("cancels a queued process-owned workflow explicitly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const gate = yield* Deferred.make<void>();
        const layer = services({
          status: () => ({
            ...baseStatus(),
            landingState: "queued",
            landingOperationId: "landing-4",
            landingQueuePosition: 1,
          }),
          events,
          prepare: Deferred.await(gate),
        });
        yield* Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "landing-4",
            workspacePath,
            sessionId: "session-1",
            strategy: "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: true,
          });
          yield* awaitPhase("waiting");
          yield* worktreeLandings.cancel(workspacePath, "landing-4");
          const snapshot = yield* worktreeLandings.inspect({
            workspacePath,
            sessionId: "session-1",
          });
          expect(events).toEqual(["prepare", "cancel"]);
          expect(snapshot.operation).toBeUndefined();
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("persists and completes resolve-after-landing before terminal acknowledgement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const resolved = yield* Deferred.make<string>();
        const layer = services({
          status: baseStatus,
          events,
          resolve: (workingDirectory) =>
            Deferred.succeed(resolved, workingDirectory).pipe(
              Effect.as({
                projectPath: "/project",
                workingDirectory,
                resolvedSessionIds: ["session-1"],
                failures: [],
              }),
            ),
        });
        yield* Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "landing-resolve",
            workspacePath,
            sessionId: "session-1",
            strategy: "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: false,
            resolveAfterLanding: true,
          });
          expect(yield* Deferred.await(resolved)).toBe(workspacePath);
          yield* awaitPhase("landed");
          const snapshot = yield* worktreeLandings.inspect({
            workspacePath,
            sessionId: "session-1",
          });
          expect(snapshot.operation).not.toHaveProperty("pauseReason");
          expect(() => Schema.decodeUnknownSync(WorktreeLandingSnapshot)(snapshot)).not.toThrow();
          const operationUpdates = yield* (yield* worktreeLandings.observeOperations()).pipe(
            Stream.take(1),
            Stream.runCollect,
          );
          expect(() =>
            Schema.decodeUnknownSync(WorktreeOperationCatalogUpdate)(operationUpdates[0]),
          ).not.toThrow();
          expect(events).toEqual([
            "resolve-intent:true",
            "prepare",
            "land",
            "resolve-intent:false",
          ]);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );

  it.effect("recovers a landed resolve intent when the terminal operation is absent", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const landed: WorktreeRecord = { ...record, state: "landed", resolveAfterLanding: true };
      const layer = services({
        status: () => undefined,
        records: () => [landed],
        events,
        resolve: (workingDirectory) =>
          Effect.succeed({
            projectPath: "/project",
            workingDirectory,
            resolvedSessionIds: ["session-1"],
            failures: [],
          }),
      });
      const snapshot = yield* worktreeLandings
        .inspect({ workspacePath, sessionId: "session-1" })
        .pipe(Effect.provide(layer));
      expect(snapshot.operation).toBeUndefined();
      expect(snapshot.status).toBeUndefined();
      expect(events).toEqual(["resolve-intent:false"]);
    }),
  );
});
