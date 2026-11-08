import { Context, Effect, FiberMap, Layer, SubscriptionRef } from "effect";
import type { AutoMergeRequest, ProjectAutoMerge } from "../../contracts/worktrees/auto-merge";
import type { WorktreeLandingOperation } from "../../contracts/worktrees/worktree-landing-data";

export interface WorktreeLandingCoordinatorState {
  readonly operations: ReadonlyMap<string, WorktreeLandingOperation>;
  readonly autoMergeProjects?: ReadonlyArray<ProjectAutoMerge>;
  readonly autoMergeRunId?: string;
  readonly autoMergeRequests?: ReadonlyArray<AutoMergeRequest>;
}

export interface WorktreeLandingCoordinatorService {
  readonly state: SubscriptionRef.SubscriptionRef<WorktreeLandingCoordinatorState>;
  readonly fibers: FiberMap.FiberMap<string>;
}

/** Process-scoped transient owner for authoritative Managed Worktree landing workflows. */
export class WorktreeLandingCoordinator extends Context.Service<
  WorktreeLandingCoordinator,
  WorktreeLandingCoordinatorService
>()("cake/services/worktrees/WorktreeLandingCoordinator") {}

export const WorktreeLandingCoordinatorLive = Layer.effect(
  WorktreeLandingCoordinator,
  Effect.gen(function* () {
    const runId = crypto.randomUUID();
    const state = yield* SubscriptionRef.make<WorktreeLandingCoordinatorState>({
      operations: new Map(),
      autoMergeProjects: [],
      autoMergeRunId: runId,
    });
    const fibers = yield* FiberMap.make<string>();
    return WorktreeLandingCoordinator.of({ state, fibers });
  }),
);
