import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, SubscriptionRef } from "effect";
import { expect, vi } from "vitest";
import { VsCodeServer } from "../../../src/services/vscode/VsCodeServer";
import { initializeBackend } from "../../../src/backend/initializeBackend";
import {
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorLive,
} from "../../../src/services/worktrees/WorktreeLandingCoordinator";
import {
  defaultApplicationState,
  type ApplicationState as ApplicationStateValue,
} from "../../../src/contracts/application/application-data";
import type { WorktreeRecord } from "../../../src/contracts/worktrees/managed-worktree-data";
import { SavedDraftStorage } from "../../../src/services/storage/SavedDraftStorage";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { fakeApplicationState } from "../../helpers/fakes/applicationState";
import { fakeCakeSessionRuntimes } from "../../helpers/fakes/cakeSessionRuntimes";
import { fakeManagedWorktrees } from "../../helpers/fakes/managedWorktrees";
import { fakeProjectAccess } from "../../helpers/fakes/projectAccess";

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
          WorktreeLandingCoordinatorLive,
          fakeApplicationState({
            initialize: () =>
              Effect.sync(() => {
                initialized();
                current = state;
                return state;
              }),
            snapshot: () => current,
          }),
          Layer.mock(VsCodeServer, { leaseFor: () => undefined, refreshStatus: () => Effect.void }),
          fakeProjectAccess({ allow: (path) => Effect.sync(() => allow(path)) }),
          fakeManagedWorktrees({ records: () => Effect.succeed(worktrees) }),
          Layer.mock(SavedDraftStorage, { list: () => Effect.succeed([]) }),
          fakeCakeSessionRuntimes(),
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

it.effect(
  "awaits stored preferences before publishing Auto-merge or starting downstream initialization",
  () =>
    Effect.gen(function* () {
      const loading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let current = defaultApplicationState();
      const downstream = vi.fn();
      const application = fakeApplicationState({
        snapshot: () => current,
        initialize: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(loading, undefined);
            yield* Deferred.await(release);
            current = {
              ...defaultApplicationState(),
              projects: [
                {
                  path: "/a",
                  name: "A",
                  addedAt: "2026-01-01T00:00:00Z",
                  lastOpenedAt: "2026-01-01T00:00:00Z",
                  autoMergeEnabled: true,
                },
              ],
            };
            return current;
          }),
      });
      yield* Effect.gen(function* () {
        const coordinator = yield* WorktreeLandingCoordinator;
        const startup = yield* initializeBackend().pipe(Effect.forkChild);
        yield* Deferred.await(loading);
        expect((yield* SubscriptionRef.get(coordinator.state)).autoMergeProjects).toEqual([]);
        expect(downstream).not.toHaveBeenCalled();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(startup);
        expect(
          (yield* SubscriptionRef.get(coordinator.state)).autoMergeProjects?.[0]?.enabled,
        ).toBe(true);
        expect(downstream).toHaveBeenCalled();
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            application,
            WorktreeLandingCoordinatorLive,
            fakeProjectAccess({ allow: () => Effect.sync(() => downstream()) }),
            fakeManagedWorktrees({ records: () => Effect.succeed([]) }),
            Layer.mock(SavedDraftStorage, { list: () => Effect.succeed([]) }),
            fakeCakeSessionRuntimes(),
            Layer.mock(VsCodeServer, {
              leaseFor: () => undefined,
              refreshStatus: () => Effect.void,
            }),
            Layer.succeed(ProjectSessionConfiguration, {
              agentDirectory: "/cake",
              sessionDirectory: "/cake/sessions",
              resolvedSessionDirectory: "/cake/resolved",
            }),
          ),
        ),
      );
    }),
);
