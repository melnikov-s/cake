import { Clock, Context, Effect, FiberMap, Layer, Stream, SubscriptionRef } from "effect";
import { makeLandingPhaseRecorder } from "../diagnostics/landing-phase-diagnostics";
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
    const recordPhases = makeLandingPhaseRecorder();
    yield* SubscriptionRef.changes(state).pipe(
      Stream.runForEach((snapshot) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          for (const record of recordPhases(snapshot.operations, now))
            yield* Effect.logInfo("Cake landing phase", record);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const fibers = yield* FiberMap.make<string>();
    return WorktreeLandingCoordinator.of({ state, fibers });
  }),
);
