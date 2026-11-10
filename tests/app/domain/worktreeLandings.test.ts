import { it } from "@effect/vitest";
import {
  ResolutionCleanupFailed,
  type WorkingDirectoryResolutionResult,
} from "../../../src/contracts/project-sessions/project-session-resolution";
import {
  Deferred,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { describe, expect } from "vitest";
import { TestClock } from "effect/testing";
import {
  type WorktreeLandingError,
  type WorktreeLandingPhase,
  type WorktreeLandingOperation,
  WorktreeLandingSnapshot,
} from "../../../src/contracts/worktrees/worktree-landing-data";
import { WorktreeOperationCatalogUpdate } from "../../../src/contracts/worktrees/worktree-operation-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import type { CakePrompts } from "../../../src/contracts/application/cake-prompt-data";
import * as worktreeLandings from "../../../src/domain/worktrees/worktreeLandings";
import * as worktreeLifecycle from "../../../src/domain/worktrees/worktreeLifecycle";
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
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
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
  cacheWarm?: boolean;
  contextMetadata?: import("../../../src/contracts/conversations/session-context-metadata").SessionContextMetadata;
  prune?: Effect.Effect<
    import("../../../src/contracts/project-sessions/session-compaction").IdleCompactionResult,
    WorktreeLandingAgentError
  >;
  rebase?: () => import("../../../src/contracts/worktrees/worktree-contract").WorktreeRebaseOutcome;
  statusWait?: Effect.Effect<void>;
  landing?: () => "merge" | "pull-request";
  records?: () => ReadonlyArray<WorktreeRecord>;
  events: string[];
  land?: () => WorktreeLandOutcome;
  prompt?: (text: string) => void;
  promptWait?: Effect.Effect<void>;
  prompts?: Partial<CakePrompts>;
  prepare?: Effect.Effect<void, ManagedWorktreeError>;
  queued?: boolean;
  release?: Effect.Effect<void>;
  setResolveIntent?: (enabled: boolean) => Effect.Effect<void, ManagedWorktreeError>;
  cancel?: (onlyIfQueued: boolean | undefined) => Effect.Effect<void, ManagedWorktreeError>;
  resolve?: (
    workingDirectory: string,
  ) => Effect.Effect<WorkingDirectoryResolutionResult, WorktreeLandingError>;
}) {
  const managed = ManagedWorktrees.of({
    records: () => Effect.sync(() => options.records?.() ?? [options.status()?.record ?? record]),
    observe: () => Stream.never,
    observeLandingQueue: () => Stream.succeed([]),
    createCheckout: () => Effect.fail(failure("createCheckout")),
    awaitSetup: () => Effect.void,
    status: () =>
      Effect.sync(options.status).pipe(Effect.tap(() => options.statusWait ?? Effect.void)),
    setResolveAfterLanding: (_worktreePath, enabled) =>
      Effect.sync(() => options.events.push(`resolve-intent:${enabled}`)).pipe(
        Effect.andThen(options.setResolveIntent?.(enabled) ?? Effect.void),
      ),
    prepareLanding: () =>
      Effect.sync(() => options.events.push("prepare")).pipe(
        Effect.andThen(options.queued ? Effect.void : (options.prepare ?? Effect.void)),
      ),
    land: (_path, _operationId, _request, onProgress, authorize) =>
      Effect.gen(function* () {
        if (options.queued) {
          yield* onProgress?.("queued") ?? Effect.void;
          yield* options.prepare ?? Effect.void;
          yield* onProgress?.("landing") ?? Effect.void;
        }
        yield* authorize ?? Effect.void;
        options.events.push("land");
        return options.land?.() ?? ({ outcome: "landed" } as const);
      }),
    releaseLanding: () => options.release ?? Effect.void,
    cancelLanding: (_workspacePath, _operationId, onlyIfQueued) =>
      options.cancel?.(onlyIfQueued) ?? Effect.sync(() => void options.events.push("cancel")),
    rebase: () => (options.rebase ? Effect.sync(options.rebase) : Effect.fail(failure("rebase"))),
    discard: () => Effect.fail(failure("discard")),
    cleanupResolved: () => Effect.fail(failure("cleanupResolved")),
    restoreResolved: () => Effect.fail(failure("restoreResolved")),
    proposeSquashMessage: () => Effect.fail(failure("proposeSquashMessage")),
  });
  const agent = WorktreeLandingAgent.of({
    promptContext: () =>
      Effect.succeed({
        estimatedTokens: options.contextMetadata?.estimatedTokens,
        cacheWarm: options.cacheWarm ?? false,
      }),
    toolPrune: () =>
      Effect.sync(() => options.events.push("prune")).pipe(
        Effect.andThen(options.prune ?? Effect.succeed({ status: "compacted" as const })),
      ),
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
    snapshot: () => ({
      ...state,
      projects: [
        {
          path: record.projectPath,
          name: "Project",
          addedAt: record.createdAt,
          lastOpenedAt: record.createdAt,
          settings: {
            ...defaultProjectSettings(),
            worktreeLanding: options.landing?.() ?? "merge",
          },
        },
      ],
    }),
    changes: () => Stream.never,
    transact: (transition) => transition(state),
  });
  return Layer.mergeAll(
    Layer.succeed(ApplicationState, application),
    Layer.mock(SessionFamilyStorage, { invalidateAutoMerge: () => Effect.void }),
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

describe("WorktreeLandings manual prompt confirmation", () => {
  const paths = [
    "commit",
    "squash-message",
    "preserve-conflict",
    "squash-conflict",
    "rebase-conflict",
  ] as const;
  const choices = ["run", "cancel", "tool-prune", "busy", "failed", "unchanged"] as const;
  for (const path of paths) {
    it.effect.each(choices)(path + " / %s gates dispatch once", (choice) => {
      const events: string[] = [];
      let repaired = false;
      const blocked = () => ({
        ...baseStatus(),
        dirtyCount: repaired ? 0 : 1,
        rebasing: path === "rebase-conflict" && !repaired,
      });
      const layer = services({
        events,
        status: blocked,
        release: Effect.sync(() => {
          events.push("release");
        }),
        contextMetadata: { estimatedTokens: 120_000 },
        rebase: () =>
          repaired ? { outcome: "rebased" } : { outcome: "resolving", files: ["shared.ts"] },
        land: () =>
          repaired
            ? { outcome: "landed" }
            : path === "squash-message"
              ? { outcome: "proposal" }
              : { outcome: "resolving", files: ["shared.ts"] },
        prune:
          choice === "failed"
            ? Effect.fail(
                new WorktreeLandingAgentError({ operation: "toolPrune", message: "Prune failed" }),
              )
            : Effect.succeed({
                status:
                  choice === "busy" ? "busy" : choice === "unchanged" ? "unchanged" : "compacted",
              }),
        prompt: () => {
          repaired = true;
        },
      });
      return Effect.gen(function* () {
        const coordinator = yield* WorktreeLandingCoordinator;
        if (path === "rebase-conflict")
          yield* worktreeLandings.startRebase({
            operationId: "manual",
            workspacePath,
            sessionId: "owner",
            confirmAgentPrompts: true,
          });
        else
          yield* worktreeLandings.start({
            operationId: "manual",
            workspacePath,
            sessionId: "owner",
            strategy: path.startsWith("squash") ? "squash" : "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: path === "commit",
            confirmAgentPrompts: true,
          });
        const pending = Option.getOrThrow(
          yield* SubscriptionRef.changes(coordinator.state).pipe(
            Stream.map((state) => state.operations.get(workspacePath)?.promptConfirmation),
            Stream.filter((confirmation) => confirmation !== undefined),
            Stream.runHead,
          ),
        );
        expect(events).not.toContain("prompt");
        if (path !== "rebase-conflict") expect(events).toContain("release");
        // Inspection cannot bypass a pending confirmation, even if Git is now clean.
        yield* worktreeLandings.inspect({ workspacePath, sessionId: "owner" });
        expect(events).not.toContain("prompt");
        const answer = {
          workspacePath,
          operationId: "manual",
          confirmationId: pending.id,
          decision: choice === "run" || choice === "cancel" ? choice : ("tool-prune" as const),
        };
        yield* worktreeLandings.confirmAgentPrompt(answer);
        yield* FiberMap.awaitEmpty(coordinator.fibers);
        const dispatch = choice === "run" || choice === "tool-prune";
        expect(events.filter((event) => event === "prompt")).toHaveLength(dispatch ? 1 : 0);
        expect(events.filter((event) => event === "prune")).toHaveLength(
          choice === "run" || choice === "cancel" ? 0 : 1,
        );
        if (choice === "tool-prune")
          expect(events.indexOf("prune")).toBeLessThan(events.indexOf("prompt"));
        const duplicate = yield* worktreeLandings.confirmAgentPrompt(answer).pipe(Effect.flip);
        expect(duplicate.operation).toBe("confirmAgentPrompt");
        if (!dispatch) {
          const snapshot = yield* worktreeLandings.inspect({ workspacePath, sessionId: "owner" });
          expect(snapshot.operation?.phase).toBe("stalled");
        }
      }).pipe(Effect.provide(layer), Effect.scoped);
    });

    it.effect(path + " tool-originated dispatch never waits for UI", () => {
      const events: string[] = [];
      let repaired = false;
      const layer = services({
        events,
        status: () => ({ ...baseStatus(), dirtyCount: repaired ? 0 : 1 }),
        contextMetadata: { estimatedTokens: 200_000 },
        rebase: () => ({ outcome: "resolving", files: ["shared.ts"] }),
        land: () =>
          repaired
            ? { outcome: "landed" }
            : path === "squash-message"
              ? { outcome: "proposal" }
              : { outcome: "resolving", files: ["shared.ts"] },
        prompt: () => {
          repaired = true;
        },
      });
      return Effect.gen(function* () {
        if (path === "rebase-conflict")
          yield* worktreeLandings.startRebase({
            operationId: "tool",
            workspacePath,
            sessionId: "owner",
          });
        else
          yield* worktreeLandings.start({
            operationId: "tool",
            workspacePath,
            sessionId: "owner",
            strategy: path.startsWith("squash") ? "squash" : "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: path === "commit",
          });
        const coordinator = yield* WorktreeLandingCoordinator;
        yield* FiberMap.awaitEmpty(coordinator.fibers);
        expect(events.filter((event) => event === "prompt")).toHaveLength(1);
        expect(
          (yield* SubscriptionRef.get(coordinator.state)).operations.get(workspacePath)
            ?.promptConfirmation,
        ).toBeUndefined();
        expect(events).not.toContain("prune");
      }).pipe(Effect.provide(layer), Effect.scoped);
    });
  }

  it.effect(
    "manual retry confirms again, while a tool retry cancels the UI wait and dispatches normally",
    () => {
      const events: string[] = [];
      let dirty = true;
      return Effect.gen(function* () {
        const coordinator = yield* WorktreeLandingCoordinator;
        const pending = () =>
          SubscriptionRef.changes(coordinator.state).pipe(
            Stream.map((state) => state.operations.get(workspacePath)?.promptConfirmation),
            Stream.filter((confirmation) => confirmation !== undefined),
            Stream.filter((confirmation) => confirmation.decision === undefined),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          );
        yield* worktreeLandings.start({
          operationId: "retry",
          workspacePath,
          sessionId: "owner",
          strategy: "preserve",
          allowDirtyTarget: false,
          commitBeforeLanding: true,
          confirmAgentPrompts: true,
        });
        const first = yield* pending();
        yield* worktreeLandings.confirmAgentPrompt({
          workspacePath,
          operationId: "retry",
          confirmationId: first.id,
          decision: "cancel",
        });
        yield* FiberMap.awaitEmpty(coordinator.fibers);
        yield* worktreeLandings.retry({
          workspacePath,
          sessionId: "owner",
          confirmAgentPrompts: true,
        });
        const second = yield* pending();
        expect(second.id).not.toBe(first.id);
        expect(events).not.toContain("prompt");
        yield* worktreeLandings.retry({ workspacePath, sessionId: "owner" });
        yield* FiberMap.awaitEmpty(coordinator.fibers);
        expect(events.filter((event) => event === "prompt")).toHaveLength(1);
        expect(
          (yield* SubscriptionRef.get(coordinator.state)).operations.get(workspacePath)
            ?.promptConfirmation,
        ).toBeUndefined();
        const stale = yield* worktreeLandings
          .confirmAgentPrompt({
            workspacePath,
            operationId: "retry",
            confirmationId: second.id,
            decision: "run",
          })
          .pipe(Effect.flip);
        expect(stale.operation).toBe("confirmAgentPrompt");
      }).pipe(
        Effect.provide(
          services({
            events,
            status: () => ({ ...baseStatus(), dirtyCount: dirty ? 1 : 0 }),
            contextMetadata: { estimatedTokens: 50_001 },
            prompt: () => {
              dirty = false;
            },
          }),
        ),
        Effect.scoped,
      );
    },
  );

  it.effect("confirms above the threshold when observed cache warmth has expired", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      yield* TestClock.setTime(300_000);
      yield* worktreeLandings.start({
        operationId: "expired",
        workspacePath,
        sessionId: "owner",
        strategy: "preserve",
        allowDirtyTarget: false,
        commitBeforeLanding: true,
        confirmAgentPrompts: true,
      });
      const coordinator = yield* WorktreeLandingCoordinator;
      const pending = Option.getOrThrow(
        yield* SubscriptionRef.changes(coordinator.state).pipe(
          Stream.map((state) => state.operations.get(workspacePath)?.promptConfirmation),
          Stream.filter((confirmation) => confirmation !== undefined),
          Stream.runHead,
        ),
      );
      expect(events).not.toContain("prompt");
      yield* worktreeLandings.confirmAgentPrompt({
        workspacePath,
        operationId: "expired",
        confirmationId: pending.id,
        decision: "cancel",
      });
      yield* FiberMap.awaitEmpty(coordinator.fibers);
    }).pipe(
      Effect.provide(
        services({
          events,
          status: () => ({ ...baseStatus(), dirtyCount: 1 }),
          contextMetadata: {
            estimatedTokens: 50_001,
            cacheObservation: {
              provider: "anthropic",
              observedAt: new Date(0).toISOString(),
              readTokens: 0,
              writeTokens: 1,
              write1hTokens: 0,
            },
          },
        }),
      ),
      Effect.scoped,
    );
  });

  it.effect.each([
    undefined,
    { estimatedTokens: 49_999 },
    { estimatedTokens: 50_000 },
    {
      estimatedTokens: 120_000,
      cacheObservation: {
        provider: "anthropic",
        observedAt: new Date(0).toISOString(),
        readTokens: 1,
        writeTokens: 1,
        write1hTokens: 0,
      },
    },
  ])("does not confirm a small or warm context %#", (metadata) => {
    const events: string[] = [];
    let dirty = true;
    return Effect.gen(function* () {
      yield* TestClock.setTime(0);
      yield* worktreeLandings.start({
        operationId: "warm",
        workspacePath,
        sessionId: "owner",
        strategy: "preserve",
        allowDirtyTarget: false,
        commitBeforeLanding: true,
        confirmAgentPrompts: true,
      });
      yield* FiberMap.awaitEmpty((yield* WorktreeLandingCoordinator).fibers);
      expect(events).toContain("prompt");
    }).pipe(
      Effect.provide(
        services({
          events,
          contextMetadata: metadata,
          cacheWarm: metadata?.cacheObservation !== undefined,
          status: () => ({ ...baseStatus(), dirtyCount: dirty ? 1 : 0 }),
          prompt: () => {
            dirty = false;
          },
        }),
      ),
      Effect.scoped,
    );
  });
});

describe("WorktreeLandings", () => {
  it.effect.each([true, false])(
    "recovers automatic repair as a validation-only pause (rebasing=%s)",
    (rebasing) => {
      const events: string[] = [];
      return Effect.gen(function* () {
        const inspected = yield* worktreeLandings.inspect({ workspacePath, sessionId: "owner" });
        expect(inspected.operation).toMatchObject({ automatic: true, phase: "stalled" });
        expect(events).toEqual([]);
        const error = yield* worktreeLandings
          .retry({ workspacePath, sessionId: "owner" })
          .pipe(Effect.flip);
        expect(error.message).toContain("fresh commit-bound readiness");
        expect(events).toEqual([]);
      }).pipe(
        Effect.provide(
          services({
            status: () => ({
              ...baseStatus(),
              rebasing,
              record: { ...record, pendingStrategy: "preserve", pendingAutomaticLanding: true },
            }),
            events,
          }),
        ),
      );
    },
  );
  it.effect("missing project settings keep the existing direct-merge default", () =>
    Effect.gen(function* () {
      yield* worktreeLifecycle.requireDirectMerge("/project-without-settings");
      expect(
        (yield* worktreeLifecycle.forProject("/project-without-settings")).landsThroughPullRequests,
      ).toBe(false);
    }).pipe(
      Effect.provideService(
        ApplicationState,
        ApplicationState.of({
          initialize: () => Effect.succeed(defaultApplicationState()),
          current: () => Effect.succeed(defaultApplicationState()),
          snapshot: () => defaultApplicationState(),
          changes: () => Stream.never,
          transact: (transition) => transition(defaultApplicationState()),
        }),
      ),
    ),
  );

  it.effect("rejects a stale direct start request for an external project before mutation", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const result = yield* worktreeLandings
        .start({
          operationId: "stale-start",
          workspacePath,
          sessionId: "session-1",
          strategy: "preserve",
          allowDirtyTarget: false,
          commitBeforeLanding: true,
          resolveAfterLanding: true,
        })
        .pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WorktreeLandingError" } });
      expect(events).toEqual([]);
    }).pipe(
      Effect.provide(services({ status: baseStatus, events, landing: () => "pull-request" })),
    );
  });

  it.effect("manual queued execution rechecks the current external policy before Git", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let landing: "merge" | "pull-request" = "merge";
        const events: string[] = [];
        const release = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          yield* worktreeLandings.start({
            operationId: "queued-policy",
            workspacePath,
            sessionId: "session-1",
            strategy: "preserve",
            allowDirtyTarget: false,
            commitBeforeLanding: false,
          });
          yield* awaitPhase("queued");
          landing = "pull-request";
          yield* Deferred.succeed(release, undefined);
          yield* awaitPhase("failed");
          expect(events).toEqual(["prepare"]);
        }).pipe(
          Effect.provide(
            services({
              status: baseStatus,
              events,
              queued: true,
              prepare: Deferred.await(release),
              landing: () => landing,
            }),
          ),
        );
      }),
    ),
  );

  it.effect("does not adopt a persisted landing for an external project during inspection", () => {
    const events: string[] = [];
    return Effect.gen(function* () {
      const snapshot = yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
      expect(snapshot.status).toBeDefined();
      expect(snapshot.operation).toBeUndefined();
      expect(events).toEqual([]);
    }).pipe(
      Effect.provide(
        services({
          events,
          landing: () => "pull-request",
          status: () => ({ ...baseStatus(), record: { ...record, pendingStrategy: "preserve" } }),
        }),
      ),
    );
  });

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
  it.effect("projects the ready queue wait separately from reservation and preparation", () =>
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
  it.effect(
    "lets later owners commit while the head awaits its owner, then queues only ready work",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events: string[] = [];
          const firstPrompt = yield* Deferred.make<void>();
          const secondPrompt = yield* Deferred.make<void>();
          const releaseFirst = yield* Deferred.make<void>();
          const releaseSecond = yield* Deferred.make<void>();
          const landingTurn = yield* Deferred.make<void>();
          let clean = false;
          const layer = services({
            status: () => ({ ...baseStatus(), dirtyCount: clean ? 0 : 1 }),
            events,
            queued: true,
            prepare: Deferred.await(landingTurn),
          });
          yield* Effect.gen(function* () {
            const agent = WorktreeLandingAgent.of({
              promptContext: () => Effect.succeed({ estimatedTokens: undefined, cacheWarm: false }),
              toolPrune: () => Effect.succeed({ status: "compacted" }),
              promptAndWait: ({ sessionId }) =>
                Deferred.succeed(
                  sessionId === "first" ? firstPrompt : secondPrompt,
                  undefined,
                ).pipe(
                  Effect.andThen(
                    Deferred.await(sessionId === "first" ? releaseFirst : releaseSecond),
                  ),
                  Effect.andThen(
                    Effect.sync(() => {
                      clean = true;
                    }),
                  ),
                ),
            });
            yield* Effect.gen(function* () {
              const start = (id: string, path: string) =>
                worktreeLandings.start({
                  operationId: id,
                  workspacePath: path,
                  sessionId: id,
                  strategy: "preserve",
                  allowDirtyTarget: false,
                  commitBeforeLanding: true,
                });
              yield* start("first", "/first");
              yield* Deferred.await(firstPrompt);
              yield* start("second", workspacePath);
              yield* Deferred.await(secondPrompt);
              const coordinator = yield* WorktreeLandingCoordinator;
              const operations = (yield* SubscriptionRef.get(coordinator.state)).operations;
              expect(operations.get("/first")?.phase).toBe("committing");
              expect(operations.get(workspacePath)?.phase).toBe("committing");
              yield* Deferred.succeed(releaseSecond, undefined);
              yield* awaitPhase("queued");
              expect(
                (yield* SubscriptionRef.get(coordinator.state)).operations.get("/first")?.phase,
              ).toBe("committing");
              expect(events).toEqual(["prepare", "prepare"]);
              yield* worktreeLandings.cancel(workspacePath, "second");
            }).pipe(Effect.provideService(WorktreeLandingAgent, agent));
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

  it.effect.each([false, true])(
    "adopts durable paused metadata and resolve intent after process recovery (%s)",
    (resolveAfterLanding) => {
      const events: string[] = [];
      const layer = services({
        status: () => ({
          ...baseStatus(),
          landingOperationId: "recovered-landing",
          record: { ...record, pendingStrategy: "preserve", resolveAfterLanding },
        }),
        events,
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
          const snapshot = yield* worktreeLandings.inspect({
            workspacePath,
            sessionId: "session-1",
          });
          expect(snapshot.operation?.operationId).toBe("recovered-landing");
          expect(snapshot.operation?.resolveAfterLanding).toBe(resolveAfterLanding);
          yield* awaitPhase("landed");
          expect(events).toEqual(
            resolveAfterLanding
              ? ["prepare", "land", "resolve", "resolve-intent:false"]
              : ["prepare", "land"],
          );
        }).pipe(Effect.provide(layer)),
      );
    },
  );

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

  it.effect.each(["landing", "rebase"] as const)(
    "reconciles a repaired manual %s once without granting rebase merge authority",
    (kind) => {
      const events: string[] = [];
      const layer = services({
        status: baseStatus,
        events,
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
      return Effect.gen(function* () {
        const coordinator = yield* WorktreeLandingCoordinator;
        yield* SubscriptionRef.update(coordinator.state, (state) => ({
          ...state,
          operations: new Map<string, WorktreeLandingOperation>([
            [
              workspacePath,
              {
                operationId: "repaired",
                workspacePath,
                sessionId: "session-1",
                kind,
                phase: "stalled",
                pauseReason: kind === "landing" ? "conflict" : "rebase-conflict",
                strategy: "preserve",
                allowDirtyTarget: false,
                resolveAfterLanding: kind === "landing",
              },
            ],
          ]),
        }));
        yield* Effect.all(
          [
            worktreeLandings.inspect({ workspacePath, sessionId: "session-1" }),
            worktreeLandings.inspect({ workspacePath, sessionId: "session-1" }),
          ],
          { concurrency: "unbounded" },
        );
        yield* awaitPhase(kind === "landing" ? "landed" : "complete");
        yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
        expect(events.filter((event) => event === "land")).toHaveLength(kind === "landing" ? 1 : 0);
        expect(events.filter((event) => event === "resolve")).toHaveLength(
          kind === "landing" ? 1 : 0,
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each([true, false])(
    "keeps recovered automatic intent paused even after Git repair (clean=%s)",
    (clean) => {
      const events: string[] = [];
      return Effect.gen(function* () {
        yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
        yield* awaitPhase("stalled");
        yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
        const operation = (yield* SubscriptionRef.get(
          (yield* WorktreeLandingCoordinator).state,
        )).operations.get(workspacePath);
        expect(operation).toMatchObject({
          phase: "stalled",
          automatic: true,
          resolveAfterLanding: true,
        });
        expect(
          (yield* worktreeLandings
            .retry({ workspacePath, sessionId: "session-1" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(events).not.toContain("land");
      }).pipe(
        Effect.provide(
          services({
            status: () => ({
              ...baseStatus(),
              dirtyCount: clean ? 0 : 1,
              rebasing: !clean,
              record: { ...record, pendingStrategy: "preserve", pendingAutomaticLanding: true },
            }),
            events,
          }),
        ),
      );
    },
  );

  it.effect.each(["resolved", "missing"] as const)(
    "retires a stale paused operation for a %s worktree without replay",
    (state) => {
      const events: string[] = [];
      let releases = 0;
      return Effect.gen(function* () {
        yield* SubscriptionRef.update((yield* WorktreeLandingCoordinator).state, (current) => ({
          ...current,
          operations: new Map<string, WorktreeLandingOperation>([
            [
              workspacePath,
              {
                operationId: "stale",
                workspacePath,
                sessionId: "session-1",
                kind: "landing",
                phase: "stalled",
                allowDirtyTarget: false,
                resolveAfterLanding: true,
              },
            ],
          ]),
        }));
        const result = yield* worktreeLandings.inspect({ workspacePath, sessionId: "session-1" });
        expect(result.operation?.phase).toBe("failed");
        expect(releases).toBe(1);
        expect(events).toEqual([]);
      }).pipe(
        Effect.provide(
          services({
            status: () => undefined,
            records: () => [{ ...record, state }],
            events,
            release: Effect.sync(() => {
              releases += 1;
            }),
          }),
        ),
      );
    },
  );

  it.effect(
    "does not revive canceled intent from an inspection that read Git before cancellation",
    () =>
      Effect.gen(function* () {
        const read = yield* Deferred.make<void>();
        const returnStatus = yield* Deferred.make<void>();
        const events: string[] = [];
        let durable: WorktreeRecord = {
          ...record,
          pendingStrategy: "preserve",
          pendingLandingOperationId: "paused",
        };
        const layer = services({
          events,
          records: () => [durable],
          status: () => ({ ...baseStatus(), record: durable }),
          statusWait: Deferred.succeed(read, undefined).pipe(
            Effect.andThen(Deferred.await(returnStatus)),
          ),
          cancel: () =>
            Effect.sync(() => {
              durable = record;
            }),
        });
        yield* Effect.gen(function* () {
          const coordinator = yield* WorktreeLandingCoordinator;
          yield* SubscriptionRef.update(coordinator.state, (state) => ({
            ...state,
            operations: new Map<string, WorktreeLandingOperation>([
              [
                workspacePath,
                {
                  operationId: "paused",
                  workspacePath,
                  sessionId: "session-1",
                  kind: "landing",
                  phase: "stalled",
                  pauseReason: "conflict",
                  allowDirtyTarget: false,
                },
              ],
            ]),
          }));
          const inspecting = yield* worktreeLandings
            .inspect({ workspacePath, sessionId: "session-1" })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(read);
          yield* worktreeLandings.cancel(workspacePath, "paused");
          yield* Deferred.succeed(returnStatus, undefined);
          expect((yield* Fiber.join(inspecting)).operation).toBeUndefined();
          expect((yield* SubscriptionRef.get(coordinator.state)).operations.size).toBe(0);
          expect(events).toEqual([]);
        }).pipe(Effect.provide(layer));
      }),
  );

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
          expect(events).toEqual(["prepare", "cancel", "cancel"]);
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
