import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { describe } from "vitest";
import * as managedWorktrees from "../../../src/domain/managedWorktrees";
import { defaultApplicationState } from "../../../src/domain/application-data";
import { PiSessions } from "../../../src/services/pi/PiSessions";
import { ProjectSessionEnvironment } from "../../../src/services/project-sessions/ProjectSessionEnvironment";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import {
  SessionCatalogChanges,
  type SessionCatalogChange,
} from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { Terminal } from "../../../src/services/terminal/Terminal";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import type { WorktreeRecord } from "../../../src/ipc/worktree-contract";

const record = (
  projectPath: string,
  worktreePath: string,
  state: WorktreeRecord["state"] = "landed",
): WorktreeRecord => ({
  projectPath,
  worktreePath,
  branch: `agent/${worktreePath.slice(1)}`,
  baseBranch: "main",
  state,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const makeLayer = (options: {
  records: readonly WorktreeRecord[];
  resolvedWorkingDirectories: readonly string[];
  activeWorkingDirectories?: readonly string[];
  activateAfterCatalogChecks?: Readonly<Record<string, number>>;
  runningWorkingDirectories?: readonly string[];
  discarded: string[];
  changes: SessionCatalogChange[];
}) => {
  const applicationState = {
    ...defaultApplicationState(),
    projects: [
      {
        path: "/project",
        name: "Project",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        path: "/other-project",
        name: "Other",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const catalogChecks = new Map<string, number>();
  const locations = options.records.map((worktree) => ({
    projectPath: worktree.projectPath,
    projectName: worktree.projectPath === "/project" ? "Project" : "Other",
    workingDirectory: worktree.worktreePath,
    sessionDirectory: `/sessions${worktree.worktreePath}`,
    resolvedSessionDirectory: "/resolved-sessions",
    managedWorktree: worktree,
  }));
  return Layer.mergeAll(
    Layer.mock(ApplicationState, {
      current: () => Effect.succeed(applicationState),
      snapshot: () => applicationState,
    }),
    Layer.mock(ProjectAccess, { isAllowed: () => Effect.succeed(true) }),
    Layer.mock(ProjectSessionEnvironment, { locations: () => Effect.succeed(locations) }),
    Layer.mock(SessionArchiveStorage, {
      projectMigrationComplete: () => Effect.succeed(true),
      resolvedProjects: (projectPath) =>
        Stream.fromIterable(
          options.resolvedWorkingDirectories.map((workingDirectory, index) => ({
            version: 1 as const,
            sessionId: `resolved-${index}`,
            title: `Resolved ${index}`,
            projectPath,
            projectName: "Project",
            workingDirectory,
            activeRoot: `/sessions${workingDirectory}`,
            resolvedRoot: "/resolved-sessions",
            createdAt: "2026-01-01T00:00:00.000Z",
            modifiedAt: "2026-01-02T00:00:00.000Z",
          })),
        ),
    }),
    Layer.mock(PiSessions, {
      catalog: ({ workingDirectory }) => {
        const checks = (catalogChecks.get(workingDirectory) ?? 0) + 1;
        catalogChecks.set(workingDirectory, checks);
        const activeAfter = options.activateAfterCatalogChecks?.[workingDirectory];
        return options.activeWorkingDirectories?.includes(workingDirectory) ||
          (activeAfter !== undefined && checks > activeAfter)
          ? Stream.make({
              id: `active-${workingDirectory}`,
              title: "Active",
              created: "2026-01-01T00:00:00.000Z",
              modified: "2026-01-02T00:00:00.000Z",
              messageCount: 1,
              resolved: false,
            })
          : Stream.empty;
      },
    }),
    Layer.mock(ManagedWorktrees, {
      records: () => Effect.succeed(options.records),
      discard: (workingDirectory) =>
        Effect.sync(() => {
          options.discarded.push(workingDirectory);
        }),
    }),
    Layer.mock(Terminal, {
      runningProgramCount: (workingDirectory) =>
        Effect.succeed(options.runningWorkingDirectories?.includes(workingDirectory) ? 1 : 0),
      closeWorkingDirectory: () => Effect.void,
    }),
    Layer.mock(SessionCatalogChanges, {
      publish: (change) =>
        Effect.sync(() => {
          options.changes.push(change);
        }),
    }),
  );
};

describe("Managed Worktrees domain cleanup", () => {
  it.effect("selects eligible landed worktrees from main-owned project and session state", () => {
    const discarded: string[] = [];
    const changes: SessionCatalogChange[] = [];
    const records = [
      record("/project", "/eligible"),
      record("/project", "/active"),
      record("/project", "/without-resolved-session"),
      record("/project", "/already-retired", "resolved"),
      record("/other-project", "/other"),
    ];
    const layer = makeLayer({
      records,
      resolvedWorkingDirectories: ["/eligible", "/active", "/already-retired", "/other"],
      activeWorkingDirectories: ["/active"],
      discarded,
      changes,
    });
    return Effect.gen(function* () {
      const plan = yield* managedWorktrees.inspectResolvedForProject("/project");
      assert.deepEqual(plan.workingDirectories, ["/eligible"]);
      const result = yield* managedWorktrees.discardResolvedForProject("/project");
      assert.deepEqual(result.discardedWorkingDirectories, ["/eligible"]);
      assert.deepEqual(result.failures, []);
      assert.deepEqual(discarded, ["/eligible"]);
      assert.deepEqual(changes, [
        {
          _tag: "ProjectSessionChanged",
          sessionId: "resolved-0",
          projectPath: "/project",
          workingDirectory: "/eligible",
          resolved: true,
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not discard a worktree that gains an active session after discovery", () => {
    const discarded: string[] = [];
    const changes: SessionCatalogChange[] = [];
    return Effect.gen(function* () {
      const result = yield* managedWorktrees.discardResolvedForProject("/project");
      assert.deepEqual(result.discardedWorkingDirectories, []);
      assert.deepEqual(result.failures, [
        {
          workingDirectory: "/worktree",
          message: "Working Directory is no longer eligible for resolved worktree cleanup",
        },
      ]);
      assert.deepEqual(discarded, []);
    }).pipe(
      Effect.provide(
        makeLayer({
          records: [record("/project", "/worktree")],
          resolvedWorkingDirectories: ["/worktree"],
          activateAfterCatalogChecks: { "/worktree": 1 },
          discarded,
          changes,
        }),
      ),
    );
  });

  it.effect("reports a per-worktree failure and continues cleanup", () => {
    const discarded: string[] = [];
    const changes: SessionCatalogChange[] = [];
    return Effect.gen(function* () {
      const result = yield* managedWorktrees.discardResolvedForProject("/project");
      assert.deepEqual(result.discardedWorkingDirectories, ["/second"]);
      assert.deepEqual(result.failures, [
        {
          workingDirectory: "/first",
          message: "Running terminal programs require confirmation before cleanup",
        },
      ]);
      assert.deepEqual(discarded, ["/second"]);
    }).pipe(
      Effect.provide(
        makeLayer({
          records: [record("/project", "/first"), record("/project", "/second")],
          resolvedWorkingDirectories: ["/first", "/second"],
          runningWorkingDirectories: ["/first"],
          discarded,
          changes,
        }),
      ),
    );
  });
});
