import { it } from "@effect/vitest";
import { type Duration, Effect, Layer } from "effect";
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
import { WorktreeLandingCoordinatorLive } from "../../../src/services/worktrees/WorktreeLandingCoordinator";
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
    Layer.mock(ApplicationState, { snapshot: () => state }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed([record]),
      status: () =>
        Effect.sync(() => ({
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
          ...harness.status,
        })),
      prepareLanding: () => harness.prepare ?? Effect.void,
      land: () => harness.land(),
      cancelLanding: () => Effect.void,
      setResolveAfterLanding: () => Effect.void,
    }),
    Layer.mock(WorktreeLandingAgent, {
      promptAndWait: ({ text }) => {
        harness.prompts.push(text);
        return harness.prompt?.(text) ?? Effect.void;
      },
    }),
    Layer.mock(WorktreeLandingCompletion, {
      resolveWorkingDirectory: () => Effect.die("merge must not resolve the session"),
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
        message: expect.stringContaining("lands work through pull requests"),
      });
      expect(harness.prompts).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layer(harness)));
  });

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
