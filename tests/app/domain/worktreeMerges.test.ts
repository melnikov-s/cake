import { it } from "@effect/vitest";
import {
  Deferred,
  type Duration,
  Effect,
  Fiber,
  Layer,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";
import {
  defaultApplicationState,
  defaultProjectSettings,
} from "../../../src/contracts/application/application-data";
import type {
  WorktreeLandOutcome,
  WorktreeStatus,
} from "../../../src/contracts/worktrees/worktree-contract";
import { ManagedWorktreeError } from "../../../src/contracts/worktrees/managed-worktrees-errors";
import * as worktreeMerges from "../../../src/domain/worktrees/worktreeMerges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { WorktreeLandingAgent } from "../../../src/services/worktrees/WorktreeLandingAgent";
import { WorktreeLandingCompletion } from "../../../src/services/worktrees/WorktreeLandingCompletion";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../../src/services/worktrees/WorktreeLandingCoordinator";
import { WorktreeLandingError } from "../../../src/contracts/worktrees/worktree-landing-data";
import { WorktreeMergeAndResolveReport } from "../../../src/contracts/worktrees/worktree-merge-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import {
  ResolutionCleanupFailed,
  type WorkingDirectoryResolutionResult,
} from "../../../src/contracts/project-sessions/project-session-resolution";
import * as worktreeLandings from "../../../src/domain/worktrees/worktreeLandings";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";
import { familyStorageHarness } from "../helpers/familyStorageHarness";

const workspacePath = "/worktrees/change";
const record = {
  projectPath: "/project",
  worktreePath: workspacePath,
  branch: "agent/change",
  baseBranch: "main",
  createdAt: new Date(0).toISOString(),
  state: "active" as const,
};

interface Harness {
  record?: WorktreeRecord;
  missingStatus?: boolean;
  events?: string[];
  resolve?: () => Effect.Effect<WorkingDirectoryResolutionResult, WorktreeLandingError>;
  status: Partial<WorktreeStatus>;
  land: () => Effect.Effect<WorktreeLandOutcome, ManagedWorktreeError>;
  prepare?: Effect.Effect<void>;
  prompt?: (text: string) => Effect.Effect<void>;
  prompts: string[];
  landing?: "merge" | "pull-request";
}

const layer = (harness: Harness) => {
  const state = {
    ...defaultApplicationState(),
    projects: [
      {
        path: "/project",
        name: "Project",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
        settings: { ...defaultProjectSettings(), worktreeLanding: harness.landing ?? "merge" },
      },
    ],
  };
  return Layer.mergeAll(
    WorktreeLandingCoordinatorLive,
    Layer.mock(SessionFamilyStorage, { invalidateAutoMerge: () => Effect.void }),
    Layer.mock(ApplicationState, { snapshot: () => state }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.sync(() => [harness.record ?? record]),
      status: () =>
        Effect.sync(() =>
          harness.missingStatus
            ? undefined
            : {
                record: harness.record ?? record,
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
                ...harness.status,
              },
        ),
      prepareLanding: () => harness.prepare ?? Effect.void,
      land: () => harness.land(),
      releaseLanding: () => Effect.void,
      cancelLanding: () => Effect.void,
      setResolveAfterLanding: (_, enabled) =>
        Effect.sync(() => {
          harness.events?.push(`intent:${enabled}`);
          if (harness.record)
            harness.record = { ...harness.record, resolveAfterLanding: enabled || undefined };
        }),
    }),
    Layer.mock(WorktreeLandingAgent, {
      promptAndWait: ({ text }) => {
        harness.prompts.push(text);
        return (harness.prompt?.(text) ?? Effect.void).pipe(Effect.as("complete" as const));
      },
    }),
    Layer.mock(WorktreeLandingCompletion, {
      resolveWorkingDirectory: () =>
        harness.resolve?.() ?? Effect.die("merge must not resolve the session"),
    }),
  );
};

const merge = (callerSessionId = "cake-chat", timeout?: Duration.Input) =>
  worktreeMerges.merge({
    sessionId: "owner",
    workspacePath,
    callerSessionId,
    ...(timeout ? { timeout } : {}),
  });

describe("WorktreeMerges.merge", () => {
  it.effect("refuses to merge a pull-request project's worktree locally", () => {
    const harness: Harness = {
      status: {},
      prompts: [],
      landing: "pull-request",
      land: () => Effect.die("a pull-request project must never land through Cake"),
    };
    return Effect.gen(function* () {
      const failure = yield* Effect.flip(merge());
      expect(failure).toMatchObject({
        _tag: "WorktreeLandingError",
        message: expect.stringContaining("merges outside Cake"),
      });
      expect(harness.prompts).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect.each(["stalled", "queued"] as const)(
    "rejects replayed %s merge operations after an external-workflow transition",
    (phase) => {
      const harness: Harness = {
        status: {},
        prompts: [],
        landing: "pull-request",
        land: () => Effect.die("must not land"),
      };
      return Effect.gen(function* () {
        yield* SubscriptionRef.update((yield* WorktreeLandingCoordinator).state, (state) => ({
          ...state,
          operations: new Map([
            [
              workspacePath,
              {
                operationId: "old",
                workspacePath,
                sessionId: "owner",
                kind: "landing" as const,
                phase,
                strategy: "preserve" as const,
                allowDirtyTarget: false,
              },
            ],
          ]),
        }));
        expect(yield* Effect.flip(merge())).toMatchObject({
          _tag: "WorktreeLandingError",
          message: expect.stringContaining("merges outside Cake"),
        });
        expect(harness.prompts).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(layer(harness)));
    },
  );

  it.effect("reports the landed commit through Cake's normal landing flow", () => {
    const harness: Harness = {
      status: {},
      prompts: [],
      land: () => Effect.succeed({ outcome: "landed", commit: "abc1234" }),
    };
    return Effect.gen(function* () {
      const report = yield* merge();
      expect(report).toMatchObject({
        command: "worktrees.merge",
        outcome: "landed",
        phase: "landed",
        sessionId: "owner",
        workingDirectory: workspacePath,
        targetBranch: "main",
        landedCommit: "abc1234",
        worktreeState: "active",
      });
      expect(report.nextStep).toContain("Landed on main at abc1234");
      expect(report.nextStep).toContain("not resolved");
      expect(harness.prompts).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect("asks the owning session to commit dirty work before landing", () => {
    const harness: Harness = {
      status: { dirtyCount: 2 },
      prompts: [],
      land: () => Effect.succeed({ outcome: "landed", commit: "abc1234" }),
      prompt: () => Effect.never,
    };
    return Effect.gen(function* () {
      const report = yield* merge("owner");
      expect(report).toMatchObject({
        outcome: "awaiting-agent",
        phase: "committing",
        pauseReason: "commit",
      });
      expect(report.nextStep).toContain("commit your uncommitted worktree changes");
      expect(report.nextStep).toContain("Finish this turn now");
      expect(harness.prompts).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect("reports conflicts the owning session was prompted to resolve", () => {
    const harness: Harness = {
      status: {},
      prompts: [],
      land: () => Effect.succeed({ outcome: "resolving", files: ["src/a.ts", "src/b.ts"] }),
      prompt: () => Effect.never,
    };
    return Effect.gen(function* () {
      const report = yield* merge("cake-chat");
      expect(report).toMatchObject({
        outcome: "awaiting-agent",
        phase: "resolving",
        pauseReason: "conflict",
        conflictFiles: ["src/a.ts", "src/b.ts"],
      });
      expect(report.nextStep).toContain("Cake prompted the owning session (owner)");
      expect(report.nextStep).toContain("src/a.ts, src/b.ts");
      expect(report.nextStep).toContain("Never land this work by hand");
      expect(harness.prompts[0]).toContain("src/a.ts");
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect("reports a stalled landing and retries it on the next merge call", () => {
    const harness: Harness = {
      status: {},
      prompts: [],
      land: () => Effect.succeed({ outcome: "resolving", files: ["src/a.ts"] }),
      // The owner's turn ends without finishing the merge resolution.
      prompt: () =>
        Effect.sync(() => {
          harness.status = { merging: true };
        }),
    };
    return Effect.gen(function* () {
      const stalled = yield* merge();
      expect(stalled).toMatchObject({ outcome: "stalled", phase: "stalled" });
      expect(stalled.nextStep).toContain("call worktrees.merge again to retry");

      harness.status = {};
      harness.land = () => Effect.succeed({ outcome: "landed", commit: "def5678" });
      const landed = yield* merge();
      expect(landed).toMatchObject({
        outcome: "landed",
        operationId: stalled.operationId,
        landedCommit: "def5678",
      });
      expect(landed).not.toHaveProperty("conflictFiles");
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect("reports landing failures without falling back to manual Git", () => {
    const harness: Harness = {
      status: {},
      prompts: [],
      land: () =>
        Effect.fail(
          new ManagedWorktreeError({
            operation: "land",
            message: "The landing target has uncommitted changes. Commit or stash them first.",
          }),
        ),
    };
    return Effect.gen(function* () {
      const report = yield* merge();
      expect(report.outcome).toBe("failed");
      expect(report.error).toContain("landing target has uncommitted changes");
      expect(report.nextStep).toContain("Never land this work by hand");
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.live("returns in-progress while the landing is still queued", () => {
    const harness: Harness = {
      status: {},
      prompts: [],
      prepare: Effect.never,
      land: () => Effect.succeed({ outcome: "landed" }),
    };
    return Effect.gen(function* () {
      const first = yield* merge("cake-chat", "20 millis");
      expect(first).toMatchObject({ outcome: "in-progress" });
      expect(first.nextStep).toContain("Call worktrees.merge again to check");
      // A second call observes the same landing instead of starting another.
      const second = yield* merge("cake-chat", "20 millis");
      expect(second.operationId).toBe(first.operationId);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });
});

/** Stateful engine boundary: successful Git landing checkpoints before lifecycle completion. */
const resolvingHarness = (): Harness => {
  const harness: Harness = {
    record: { ...record },
    status: {},
    events: [],
    prompts: [],
    land: () =>
      Effect.sync(() => {
        harness.events?.push("land");
        harness.record = { ...record, ...harness.record, state: "landed" };
        harness.status = { aheadCount: 0 };
        return { outcome: "landed", commit: "abc1234" };
      }),
    resolve: () =>
      Effect.sync(() => {
        harness.events?.push("resolve");
        return {
          projectPath: "/project",
          workingDirectory: workspacePath,
          resolvedSessionIds: ["owner"],
          failures: [],
          cleanupFailures: [],
        };
      }),
  };
  return harness;
};
const mergeAndResolve = () => worktreeMerges.mergeAndResolve({ sessionId: "owner", workspacePath });
const awaitLanded = Effect.gen(function* () {
  const coordinator = yield* WorktreeLandingCoordinator;
  return yield* SubscriptionRef.changes(coordinator.state).pipe(
    Stream.map((state) => state.operations.get(workspacePath)),
    Stream.filter((operation) => operation?.phase === "landed"),
    Stream.runHead,
  );
});

describe("WorktreeMerges.mergeAndResolve", () => {
  it.effect("refuses external merge-and-resolve without changing resolve intent", () => {
    const harness = resolvingHarness();
    harness.landing = "pull-request";
    return Effect.gen(function* () {
      expect(yield* Effect.flip(mergeAndResolve())).toMatchObject({ _tag: "WorktreeLandingError" });
      expect(harness.events).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });
  it.effect("fresh success resolves once and duplicate requests share the landing", () => {
    const harness = resolvingHarness();
    return Effect.gen(function* () {
      const reports = yield* Effect.all([mergeAndResolve(), mergeAndResolve()], {
        concurrency: "unbounded",
      });
      const again = yield* mergeAndResolve();
      for (const report of [...reports, again]) {
        expect(report).toMatchObject({
          command: "worktrees.merge-and-resolve",
          outcome: "landed-and-resolved",
          landed: true,
          resolved: true,
          resolvedSessionIds: ["owner"],
        });
        expect(() => Schema.decodeUnknownSync(WorktreeMergeAndResolveReport)(report)).not.toThrow();
        expect(report.operationId).toBe(reports[0]?.operationId);
      }
      expect(harness.events?.filter((event) => event === "land")).toHaveLength(1);
      expect(harness.events?.filter((event) => event === "resolve")).toHaveLength(1);
      expect(harness.record?.resolveAfterLanding).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect("conflicts later land and resolve automatically without another command", () => {
    const harness = resolvingHarness();
    const land = harness.land;
    return Effect.gen(function* () {
      const ownerDone = yield* Deferred.make<void>();
      let first = true;
      harness.land = () => {
        if (!first) return land();
        first = false;
        return Effect.succeed({ outcome: "resolving", files: ["src/conflict.ts"] });
      };
      harness.prompt = () => Deferred.await(ownerDone);
      const paused = yield* mergeAndResolve();
      expect(paused).toMatchObject({ outcome: "awaiting-agent", landed: false, resolved: false });
      expect(harness.record?.resolveAfterLanding).toBe(true);
      expect(harness.events).not.toContain("resolve");
      expect(paused.nextStep).toContain("No second invocation is required");
      yield* Deferred.succeed(ownerDone, undefined);
      yield* awaitLanded;
      expect(harness.events).toEqual(["intent:true", "land", "resolve", "intent:false"]);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect("upgrades an existing merge-only owner turn to durable resolve intent", () => {
    const harness = resolvingHarness();
    harness.status = { dirtyCount: 1 };
    return Effect.gen(function* () {
      const ownerDone = yield* Deferred.make<void>();
      harness.prompt = () => Deferred.await(ownerDone);
      const legacy = yield* merge();
      const upgraded = yield* mergeAndResolve();
      expect(upgraded.operationId).toBe(legacy.operationId);
      expect(upgraded.outcome).toBe("awaiting-agent");
      harness.status = {};
      yield* Deferred.succeed(ownerDone, undefined);
      yield* awaitLanded;
      expect(harness.events?.filter((event) => event === "resolve")).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect(
    "landing failure leaves the session open and preserves authorized resolve intent",
    () => {
      const harness = resolvingHarness();
      harness.land = () =>
        Effect.fail(new ManagedWorktreeError({ operation: "land", message: "target dirty" }));
      return Effect.gen(function* () {
        const report = yield* mergeAndResolve();
        expect(report).toMatchObject({
          outcome: "failed",
          landed: false,
          resolved: false,
          error: "target dirty",
        });
        expect(harness.events).toEqual(["intent:true"]);
        expect(harness.record?.resolveAfterLanding).toBe(true);
      }).pipe(Effect.scoped, Effect.provide(layer(harness)));
    },
  );

  it.effect("already-landed retired checkout resolves without calling Git again", () => {
    const harness = resolvingHarness();
    harness.record = { ...record, state: "landed" };
    harness.missingStatus = true;
    harness.land = () => Effect.die("already-landed work must not remerge");
    return Effect.gen(function* () {
      expect(yield* mergeAndResolve()).toMatchObject({
        outcome: "landed-and-resolved",
        landed: true,
        resolved: true,
      });
      expect(harness.events).toEqual(["intent:true", "resolve", "intent:false"]);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect.each([false, true])(
    "reports resolution partial failure honestly and retries without relanding (typed: %s)",
    (typed) => {
      const harness = resolvingHarness();
      const resolve = harness.resolve;
      harness.resolve = () =>
        typed
          ? Effect.fail(
              new WorktreeLandingError({
                operation: "resolveWorkingDirectory",
                message: "owner active",
              }),
            )
          : Effect.succeed({
              projectPath: "/project",
              workingDirectory: workspacePath,
              resolvedSessionIds: ["child"],
              failures: [{ sessionIds: ["owner"], message: "owner active" }],
              cleanupFailures: [],
            });
      return Effect.gen(function* () {
        const report = yield* mergeAndResolve();
        expect(report).toMatchObject({
          outcome: "resolution-failed",
          landed: true,
          resolved: false,
          landedCommit: "abc1234",
          resolutionError: "owner active",
        });
        if (!typed) expect(report.resolvedSessionIds).toEqual(["child"]);
        expect(harness.record?.resolveAfterLanding).toBe(true);
        harness.resolve = resolve;
        expect(yield* mergeAndResolve()).toMatchObject({ outcome: "landed-and-resolved" });
        expect(harness.events?.filter((event) => event === "land")).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(layer(harness)));
    },
  );

  it.effect("later commits on a landed worktree still land before resolution", () => {
    const harness = resolvingHarness();
    harness.record = { ...record, state: "landed" };
    return Effect.gen(function* () {
      expect(yield* mergeAndResolve()).toMatchObject({ outcome: "landed-and-resolved" });
      expect(harness.events).toEqual(["intent:true", "land", "resolve", "intent:false"]);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect("reports committed resolution with cleanup warnings as success", () => {
    const harness = resolvingHarness();
    const cleanup = new ResolutionCleanupFailed({
      operation: "cleanup",
      resolvedSessionIds: ["owner"],
      cleanupFailures: [{ workingDirectory: workspacePath, message: "checkout busy" }],
      message: "checkout busy",
    });
    harness.resolve = () =>
      Effect.succeed({
        projectPath: "/project",
        workingDirectory: workspacePath,
        resolvedSessionIds: ["owner"],
        failures: [],
        cleanupFailures: [cleanup],
      });
    return Effect.gen(function* () {
      const report = yield* mergeAndResolve();
      expect(report).toMatchObject({
        outcome: "landed-and-resolved",
        landed: true,
        resolved: true,
        cleanupFailures: [cleanup],
      });
      expect(() => Schema.decodeUnknownSync(WorktreeMergeAndResolveReport)(report)).not.toThrow();
      expect(harness.record?.resolveAfterLanding).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

  it.effect.each([false, true])(
    "queued landing reports progress/cancellation without resolving (timeout: %s)",
    (timeout) => {
      const harness = resolvingHarness();
      harness.prepare = Effect.never;
      return Effect.gen(function* () {
        const pending = yield* Effect.forkChild(mergeAndResolve());
        const coordinator = yield* WorktreeLandingCoordinator;
        const waiting = yield* SubscriptionRef.changes(coordinator.state).pipe(
          Stream.map((state) => state.operations.get(workspacePath)),
          Stream.filter((operation) => operation?.phase === "waiting"),
          Stream.runHead,
        );
        if (timeout) {
          yield* TestClock.adjust("2 minutes");
          expect(yield* Fiber.join(pending)).toMatchObject({
            outcome: "in-progress",
            landed: false,
            resolved: false,
          });
        }
        // The accepted operation is visible before start returns to the caller.
        const operation = waiting._tag === "Some" ? waiting.value : undefined;
        expect(operation).toBeDefined();
        if (operation) yield* worktreeLandings.cancel(workspacePath, operation.operationId);
        if (!timeout)
          expect(yield* Fiber.join(pending)).toMatchObject({
            outcome: "canceled",
            landed: false,
            resolved: false,
          });
        expect(harness.events).toEqual(["intent:true", "intent:false"]);
      }).pipe(Effect.scoped, Effect.provide(layer(harness)));
    },
  );

  it.effect("stalled and canceled landings never resolve", () => {
    const harness = resolvingHarness();
    harness.land = () => Effect.succeed({ outcome: "resolving", files: ["a.ts"] });
    harness.prompt = () =>
      Effect.sync(() => {
        harness.status = { merging: true };
      });
    return Effect.gen(function* () {
      const report = yield* mergeAndResolve();
      expect(report).toMatchObject({ outcome: "stalled", landed: false, resolved: false });
      yield* worktreeLandings.cancel(workspacePath, report.operationId);
      expect(harness.events).toEqual(["intent:true", "intent:false"]);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });
});

describe("WorktreeMerges.resolveSessionWorktree", () => {
  const childPath = "/worktrees/child";
  const childRecord = { ...record, worktreePath: childPath, branch: "agent/child" };
  const environment = () => {
    const state = {
      ...defaultApplicationState(),
      projects: [
        {
          path: "/project",
          name: "Project",
          addedAt: new Date(0).toISOString(),
          lastOpenedAt: new Date(0).toISOString(),
        },
      ],
    };
    return Layer.mergeAll(
      familyStorageHarness().layer,
      Layer.mock(ApplicationState, { snapshot: () => state, current: () => Effect.succeed(state) }),
      Layer.succeed(ProjectSessionConfiguration, {
        agentDirectory: "/cake",
        sessionDirectory: "/cake/sessions",
        resolvedSessionDirectory: "/cake/resolved",
      }),
      Layer.mock(SessionArchiveStorage, { resolvedProjectEntry: () => Effect.succeed(undefined) }),
      Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([childRecord]) }),
    );
  };
  const member = (
    childSessionId: string,
    childWorkingDirectory: string,
    parentSessionId = "root",
    parentWorkingDirectory = "/project",
  ) =>
    Effect.flatMap(SessionFamilyStorage, (storage) =>
      storage.addChild({
        familyId: "family",
        parentSessionId,
        childSessionId,
        requestId: `request-${childSessionId}`,
        projectPath: "/project",
        parentWorkingDirectory,
        ...(parentWorkingDirectory === "/project"
          ? {}
          : { parentManagedWorktreePath: parentWorkingDirectory }),
        childWorkingDirectory,
        ...(childWorkingDirectory === parentWorkingDirectory
          ? {}
          : { childManagedWorktreePath: childWorkingDirectory }),
        createdAt: new Date(0).toISOString(),
      }),
    );

  it.effect("targets a session's own Managed Worktree and rejects shared or root checkouts", () =>
    Effect.gen(function* () {
      yield* member("isolated", childPath);
      yield* member("shared", "/project");
      yield* member("grandchild", childPath, "isolated", childPath);
      expect(yield* worktreeMerges.resolveSessionWorktree("isolated")).toEqual({
        sessionId: "isolated",
        workspacePath: childPath,
      });
      const root = yield* Effect.flip(worktreeMerges.resolveSessionWorktree("root"));
      expect(root.message).toContain("not an isolated Cake-managed worktree");
      const shared = yield* Effect.flip(worktreeMerges.resolveSessionWorktree("shared"));
      expect(shared.message).toContain("not an isolated Cake-managed worktree");
      const grandchild = yield* Effect.flip(worktreeMerges.resolveSessionWorktree("grandchild"));
      expect(grandchild.message).toContain("merge the parent session isolated instead");
    }).pipe(Effect.provide(environment())),
  );
});
