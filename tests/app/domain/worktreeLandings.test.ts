import { it } from "@effect/vitest";
import {
  ResolutionCleanupFailed,
  type WorkingDirectoryResolutionResult,
} from "../../../src/contracts/project-sessions/project-session-resolution";
import { Deferred, Effect, Fiber, Layer, Schema, Stream, SubscriptionRef } from "effect";
import { describe, expect } from "vitest";
import {
  type WorktreeLandingError,
  type WorktreeLandingPhase,
  WorktreeLandingSnapshot,
} from "../../../src/contracts/worktrees/worktree-landing-data";
import { WorktreeOperationCatalogUpdate } from "../../../src/contracts/worktrees/worktree-operation-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import type { CakePrompts } from "../../../src/contracts/application/cake-prompt-data";
import * as worktreeLandings from "../../../src/domain/worktrees/worktreeLandings";
import type {
  WorktreeLandOutcome,
  WorktreeStatus,
} from "../../../src/contracts/worktrees/worktree-contract";
import {
  WorktreeLandingAgent,
  WorktreeLandingAgentError,
} from "../../../src/services/worktrees/WorktreeLandingAgent";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../../src/services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingCompletion } from "../../../src/services/worktrees/WorktreeLandingCompletion";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ManagedWorktreeError } from "../../../src/contracts/worktrees/managed-worktrees-errors";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";

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
  prompts?: Partial<CakePrompts>;
  prepare?: Effect.Effect<void, ManagedWorktreeError>;
  queued?: boolean;
  setResolveIntent?: (enabled: boolean) => Effect.Effect<void, ManagedWorktreeError>;
  cancel?: (onlyIfQueued: boolean | undefined) => Effect.Effect<void, ManagedWorktreeError>;
  resolve?: (
    workingDirectory: string,
  ) => Effect.Effect<WorkingDirectoryResolutionResult, WorktreeLandingError>;
}) {
  const managed = ManagedWorktrees.of({
    records: () => Effect.succeed(options.records?.() ?? [record]),
    observe: () => Stream.never,
    createCheckout: () => Effect.fail(failure("createCheckout")),
    awaitSetup: () => Effect.void,
    hasDeferredSetup: () => Effect.succeed(false),
    status: () => Effect.sync(options.status),
    setResolveAfterLanding: (_worktreePath, enabled) =>
      Effect.sync(() => options.events.push(`resolve-intent:${enabled}`)).pipe(
        Effect.andThen(options.setResolveIntent?.(enabled) ?? Effect.void),
      ),
    prepareLanding: (_path, _operationId, onQueued) =>
      Effect.sync(() => options.events.push("prepare")).pipe(
        Effect.andThen(options.queued ? (onQueued ?? Effect.void) : Effect.void),
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
  const defaults = defaultApplicationState();
  const state = {
    ...defaults,
    cakePrompts: { ...defaults.cakePrompts, ...options.prompts },
  };
  const application = ApplicationState.of({
    initialize: () => Effect.succeed(state),
    current: () => Effect.succeed(state),
    snapshot: () => state,
    changes: () => Stream.never,
    transact: (transition) => transition(state),
  });
  return Layer.mergeAll(
    Layer.succeed(ApplicationState, application),
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
            cleanupFailures: [],
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
  it.effect(
    "reports resolve-intent persistence failure instead of leaving an unstarted waiting operation",
    () => {
      const events: string[] = [];
      const layer = services({
        status: baseStatus,
        events,
        setResolveIntent: (enabled) =>
          enabled
            ? Effect.fail(new ManagedWorktreeError({ operation: "save", message: "disk full" }))
            : Effect.void,
      });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "failed-intent",
            workspacePath,
            sessionId: "session-1",
            strategy: "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: false,
            resolveAfterLanding: true,
          });
          yield* awaitPhase("failed");
          expect(events).not.toContain("prepare");
          expect(events).not.toContain("land");
          expect(
            (yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" })).operation
              ?.error,
          ).toBe("disk full");
        }).pipe(Effect.provide(layer)),
      );
    },
  );
  it.effect("projects authoritative queue insertion before waiting for promotion", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const gate = yield* Deferred.make<void>();
        const layer = services({
          status: baseStatus,
          events,
          queued: true,
          prepare: Deferred.await(gate),
        });
        yield* Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "queued-landing",
            workspacePath,
            sessionId: "session-1",
            strategy: "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: false,
          });
          yield* awaitPhase("queued");
          expect(events).toEqual(["prepare"]);
          yield* Deferred.succeed(gate, undefined);
          yield* awaitPhase("landed");
          expect(events).toEqual(["prepare", "land"]);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
  it.effect.each(["preserve", "squash"] as const)(
    "continues a clean commit step into %s landing, including when there is nothing left to land",
    (strategy) => {
      const events: string[] = [];
      let status = { ...baseStatus(), dirtyCount: 1, aheadCount: 0 };
      const layer = services({
        status: () => status,
        events,
        prompt: () => {
          status = { ...baseStatus(), aheadCount: 0 };
        },
      });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "clean-commit",
            workspacePath,
            sessionId: "session-1",
            strategy,
            allowDirtyTarget: false,
            commitBeforeLanding: true,
          });
          yield* awaitPhase("landed");
          expect(events).toEqual(["prepare", "prompt", "land"]);
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.effect("does not recover an old landed resolve intent while a later landing is active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: string[] = [];
        const gate = yield* Deferred.make<void>();
        const prepared = yield* Deferred.make<void>();
        const landed = { ...record, state: "landed" as const, resolveAfterLanding: true };
        const layer = services({
          status: () => ({ ...baseStatus(), record: landed }),
          records: () => [landed],
          events,
          prepare: Deferred.succeed(prepared, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          resolve: (workingDirectory) =>
            Effect.sync(() => {
              events.push("resolve");
              return {
                projectPath: "/project",
                workingDirectory,
                resolvedSessionIds: [],
                failures: [],
                cleanupFailures: [],
              };
            }),
        });
        yield* Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "later-landing",
            workspacePath,
            sessionId: "session-1",
            strategy: "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: false,
            resolveAfterLanding: true,
          });
          yield* Deferred.await(prepared);
          const snapshot = yield* worktreeLandings.inspect({
            workspacePath,
            sessionId: "session-1",
          });
          expect(snapshot.operation?.phase).toBe("waiting");
          expect(events).not.toContain("resolve");
          yield* Deferred.succeed(gate, undefined);
          yield* awaitPhase("landed");
          expect(events.filter((event) => event === "resolve")).toHaveLength(1);
        }).pipe(Effect.provide(layer));
      }),
    ),
  );
  it.effect("retains landed status and exposes cleanup failures after resolution committed", () => {
    const events: string[] = [];
    const cleanupFailure = new ResolutionCleanupFailed({
      operation: "resolveWorkingDirectory",
      resolvedSessionIds: ["session-1"],
      cleanupFailures: [{ workingDirectory: workspacePath, message: "Checkout busy" }],
      message: "Resolved; checkout busy",
    });
    let landed = false;
    const layer = services({
      status: () => ({
        ...baseStatus(),
        aheadCount: landed ? 0 : 1,
        record: { ...record, state: landed ? "landed" : "active" },
      }),
      events,
      land: () => {
        landed = true;
        return { outcome: "landed" };
      },
      resolve: (workingDirectory) =>
        Effect.sync(() => {
          events.push("resolve");
          return {
            projectPath: "/project",
            workingDirectory,
            resolvedSessionIds: ["session-1"],
            failures: [],
            cleanupFailures: [cleanupFailure],
          };
        }),
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* worktreeLandings.start({
          operationId: "landing-cleanup",
          workspacePath,
          sessionId: "session-1",
          strategy: "preserve",
          allowDirtyTarget: false,
          commitBeforeLanding: false,
          resolveAfterLanding: true,
        });
        yield* awaitPhase("landed");
        const snapshot = yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
        expect(snapshot.operation?.phase).toBe("landed");
        expect(snapshot.operation?.cleanupFailures).toEqual([cleanupFailure]);
        expect(events).toEqual([
          "resolve-intent:true",
          "prepare",
          "land",
          "resolve",
          "resolve-intent:false",
        ]);
        yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
        expect(events.filter((event) => event === "land")).toHaveLength(1);
        expect(events.filter((event) => event === "resolve")).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    );
  });

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
        expect(promptText).toBe("Commit this change.");
      }).pipe(Effect.provide(layer)),
    );
  });

  it.effect("uses the configured automatic commit prompt", () => {
    const events: string[] = [];
    let status = { ...baseStatus(), dirtyCount: 1, aheadCount: 0 };
    let promptText = "";
    const layer = services({
      status: () => status,
      events,
      prompts: { worktreeCommit: "Custom commit instructions for {{target}}." },
      prompt: (text) => {
        promptText = text;
        status = baseStatus();
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* worktreeLandings.start({
          operationId: "landing-custom-prompt",
          workspacePath,
          sessionId: "session-1",
          strategy: "preserve",
          allowDirtyTarget: false,
          commitBeforeLanding: true,
        });
        yield* awaitPhase("landed");
        expect(promptText).toBe("Custom commit instructions for main.");
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

  it.effect.each(["preserve", "squash"] as const)(
    "retries a resolved %s conflict without prompting and completes merge-and-resolve",
    (strategy) => {
      const events: string[] = [];
      let status = baseStatus();
      let attempts = 0;
      const layer = services({
        status: () => status,
        events,
        land: () => {
          if (++attempts > 1) return { outcome: "landed" };
          status = {
            ...status,
            dirtyCount: 1,
            rebasing: strategy === "preserve",
            merging: strategy === "squash",
          };
          return { outcome: "resolving", files: ["shared.ts"] };
        },
        resolve: (workingDirectory) =>
          Effect.sync(() => {
            events.push("resolve");
            return {
              projectPath: "/project",
              workingDirectory,
              resolvedSessionIds: ["session-1"],
              failures: [],
              cleanupFailures: [],
            };
          }),
      });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "landing-resolved-conflict",
            workspacePath,
            sessionId: "session-1",
            strategy,
            allowDirtyTarget: false,
            commitBeforeLanding: false,
            resolveAfterLanding: true,
          });
          yield* awaitPhase("stalled");
          status = {
            ...baseStatus(),
            squashMessageReady: strategy === "squash",
            record: { ...record, pendingStrategy: strategy },
          };
          yield* worktreeLandings.retry({ workspacePath, sessionId: "session-1" });
          yield* awaitPhase("landed");
          expect(events).toEqual([
            "resolve-intent:true",
            "prepare",
            "land",
            "prompt",
            "land",
            "resolve",
            "resolve-intent:false",
          ]);
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.effect.each([false, true])(
    "retries a squash-message pause using current proposal readiness (%s)",
    (ready) => {
      const events: string[] = [];
      let status = baseStatus();
      let prompts = 0;
      const layer = services({
        status: () => status,
        events,
        land: () => (status.squashMessageReady ? { outcome: "landed" } : { outcome: "proposal" }),
        prompt: () => {
          if (++prompts === 2) status = { ...status, squashMessageReady: true };
        },
      });
      return Effect.scoped(
        Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "landing-squash-proposal",
            workspacePath,
            sessionId: "session-1",
            strategy: "squash",
            allowDirtyTarget: false,
            commitBeforeLanding: false,
          });
          yield* awaitPhase("stalled");
          status = { ...status, squashMessageReady: ready };
          yield* worktreeLandings.retry({ workspacePath, sessionId: "session-1" });
          yield* awaitPhase("landed");
          expect(events).toEqual(
            ready
              ? ["prepare", "land", "prompt", "land"]
              : ["prepare", "land", "prompt", "prompt", "land"],
          );
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.effect("retries remaining conflicts with the current file list", () => {
    const events: string[] = [];
    const prompts: string[] = [];
    let status = baseStatus();
    let files = ["original.ts"];
    const layer = services({
      status: () => status,
      events,
      land: () => {
        if (prompts.length === 2) return { outcome: "landed" };
        status = { ...baseStatus(), dirtyCount: 1, rebasing: true };
        return { outcome: "resolving", files };
      },
      prompt: (text) => {
        prompts.push(text);
        if (prompts.length === 2) status = baseStatus();
      },
    });
    return Effect.scoped(
      Effect.gen(function* () {
        yield* worktreeLandings.start({
          operationId: "landing-remaining-conflict",
          workspacePath,
          sessionId: "session-1",
          strategy: "preserve",
          allowDirtyTarget: false,
          commitBeforeLanding: false,
        });
        yield* awaitPhase("stalled");
        files = ["remaining.ts"];
        yield* worktreeLandings.retry({ workspacePath, sessionId: "session-1" });
        yield* awaitPhase("landed");
        expect(events).toEqual(["prepare", "land", "prompt", "land", "prompt", "land"]);
        expect(prompts[0]).toContain("original.ts");
        expect(prompts[1]).toContain("remaining.ts");
        expect(prompts[1]).not.toContain("original.ts");
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
          status: () => ({ ...baseStatus(), dirtyCount: 1, rebasing: true }),
          events,
          land: () => ({ outcome: "resolving", files: ["shared.ts"] }),
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
        // One landing resolves the whole family sharing the Working Directory, including nesting.
        const familyIds = ["session-1", "child-1", "child-2", "grandchild"];
        const layer = services({
          status: baseStatus,
          events,
          resolve: (workingDirectory) =>
            Deferred.succeed(resolved, workingDirectory).pipe(
              Effect.as({
                projectPath: "/project",
                workingDirectory,
                resolvedSessionIds: familyIds,
                failures: [],
                cleanupFailures: [],
              }),
            ),
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* WorktreeLandingCoordinator;
          const projected = yield* Effect.forkChild(
            SubscriptionRef.changes(coordinator.state).pipe(
              Stream.map((state) => state.operations.get(workspacePath)),
              Stream.takeUntil((current) => current?.phase === "landed"),
              Stream.runCollect,
            ),
          );
          yield* Effect.yieldNow;
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
          // The renderer presents this one operation's outcome from the authoritative set, and
          // only together with the terminal phase: an earlier change would make observers
          // refresh the retired checkout and lose the status that completion presents.
          expect(snapshot.operation?.resolvedSessionIds).toEqual(familyIds);
          expect(
            Array.from(yield* Fiber.join(projected))
              .filter((current) => current?.resolvedSessionIds !== undefined)
              .map((current) => current?.phase),
          ).toEqual(["landed"]);
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

  it.effect.each([false, true])(
    "recovers a landed resolve intent without redoing Git (cleanup failure: %s)",
    (cleanupFailed) =>
      Effect.gen(function* () {
        const events: string[] = [];
        const cleanupFailure = new ResolutionCleanupFailed({
          operation: "resolveWorkingDirectory",
          resolvedSessionIds: ["session-1"],
          cleanupFailures: [{ workingDirectory: workspacePath, message: "Checkout busy" }],
          message: "Resolved; checkout busy",
        });
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
              cleanupFailures: cleanupFailed ? [cleanupFailure] : [],
            }),
        });
        const snapshot = yield* worktreeLandings
          .inspect({ workspacePath, sessionId: "session-1" })
          .pipe(Effect.provide(layer));
        if (cleanupFailed)
          expect(snapshot.operation).toMatchObject({
            phase: "landed",
            resolveAfterLanding: true,
            resolvedSessionIds: ["session-1"],
            cleanupFailures: [cleanupFailure],
          });
        else expect(snapshot.operation).toBeUndefined();
        expect(snapshot.status).toBeUndefined();
        expect(events).toEqual(["resolve-intent:false"]);
      }),
  );
});
