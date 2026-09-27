import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { expect, vi } from "vitest";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { initializeBackend } from "../../../src/backend/initializeBackend";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/domain/application/application-data";
import type { WorktreeRecord } from "../../../src/domain/worktrees/managed-worktree-data";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import { ProjectAccess } from "../../../src/services/projects/ProjectAccess";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { CakeSessionRuntimes } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";

it.effect("restores access to registered Projects and their managed worktrees", () =>
  Effect.gen(function* () {
    const allow = vi.fn();
    const state: ApplicationStateValue = {
      ...defaultApplicationState(),
      projects: [
        {
          path: "/projects/cake",
          name: "cake",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const worktrees: WorktreeRecord[] = [
      {
        projectPath: "/projects/cake",
        worktreePath: "/worktrees/cake-feature",
        branch: "feature",
        baseBranch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        projectPath: "/projects/not-registered",
        worktreePath: "/worktrees/not-registered",
        branch: "other",
        baseBranch: "main",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    let current = defaultApplicationState();
    const initialized = vi.fn();
    yield* initializeBackend().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ApplicationState, {
            initialize: () =>
              Effect.sync(() => {
                initialized();
                current = state;
                return state;
              }),
            snapshot: () => current,
          }),
          Layer.mock(VsCodeServer, { leaseFor: () => undefined, refreshStatus: () => Effect.void }),
          Layer.mock(ProjectAccess, { allow: (path) => Effect.sync(() => allow(path)) }),
          Layer.mock(ManagedWorktrees, { records: () => Effect.succeed(worktrees) }),
          Layer.mock(SavedDraftStorage, { list: () => Effect.succeed([]) }),
          Layer.mock(CakeSessionRuntimes, {}),
          Layer.succeed(ProjectSessionConfiguration, {
            agentDirectory: "/cake",
            sessionDirectory: "/cake/sessions",
            resolvedSessionDirectory: "/cake/resolved",
          }),
        ),
      ),
    );
    expect(initialized).toHaveBeenCalledOnce();
    expect(allow).toHaveBeenCalledWith("/projects/cake");
    expect(allow).toHaveBeenCalledWith("/worktrees/cake-feature");
    expect(allow).not.toHaveBeenCalledWith("/worktrees/not-registered");
  }),
);
