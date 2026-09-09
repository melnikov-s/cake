import {
  Context,
  Effect,
  Exit,
  FiberMap,
  Layer,
  RcMap,
  Scope,
  Semaphore,
  SubscriptionRef,
} from "effect";
import type { Deferred, Schema } from "effect";
import type { PiSessionAcquireOptions, PiSessionHandle } from "../pi/PiSessions";
import type {
  ResolvedAgentModel,
  SubagentActivity,
  SubagentError,
  SubagentHandleId,
  SubagentProfile,
  SubagentResult,
  SubagentStatus,
} from "../../domain/subagents/subagent-data";

export interface SubagentHandleState {
  readonly handleId: SubagentHandleId;
  readonly parentSessionId: string;
  readonly anchorPartId: string;
  readonly workingDirectory: string;
  readonly task: string;
  readonly profile: SubagentProfile;
  readonly resolvedModel: ResolvedAgentModel;
  readonly tools: ReadonlyArray<string>;
  readonly instructions?: string;
  readonly fastMode: boolean;
  readonly retain: boolean;
  readonly remainingDepth: number;
  readonly notifyOnCompletion: boolean;
  readonly scope: Scope.Closeable;
  readonly completion: Deferred.Deferred<SubagentResult, SubagentError>;
  readonly runtimeOptions: PiSessionAcquireOptions;
  readonly parentPiHandle: PiSessionHandle;
  readonly piHandle?: PiSessionHandle;
  readonly privateSessionId?: string;
  readonly status: SubagentStatus;
  readonly activityRevision: number;
  readonly streaming: boolean;
  readonly parts: ReadonlyArray<Schema.Schema.Type<typeof Schema.Json>>;
  readonly usage?: Schema.Schema.Type<typeof Schema.Json>;
  readonly error?: string;
  readonly result?: SubagentResult;
  readonly waiters: number;
  readonly completionDisposition: "pending" | "waited" | "notifying" | "notified";
}

export interface SubagentCoordinatorState {
  readonly revision: number;
  readonly handles: ReadonlyMap<SubagentHandleId, SubagentHandleState>;
}

export interface SubagentCoordinatorService {
  readonly state: SubscriptionRef.SubscriptionRef<SubagentCoordinatorState>;
  readonly fibers: FiberMap.FiberMap<SubagentHandleId>;
  readonly slots: RcMap.RcMap<string, Semaphore.Semaphore>;
  readonly scope: Scope.Scope;
}

/** Process-scoped transient resource owner used by the free Subagents domain operations. */
export class SubagentCoordinator extends Context.Service<
  SubagentCoordinator,
  SubagentCoordinatorService
>()("cake/services/subagents/SubagentCoordinator") {}

export const SubagentCoordinatorLive = Layer.effect(
  SubagentCoordinator,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const state = yield* SubscriptionRef.make<SubagentCoordinatorState>({
      revision: 0,
      handles: new Map(),
    });
    const fibers = yield* FiberMap.make<SubagentHandleId>();
    const slots = yield* RcMap.make<string, Semaphore.Semaphore, never, never>({
      lookup: () => Semaphore.make(4),
    });
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        yield* Effect.forEach(
          current.handles.values(),
          (handle) => Scope.close(handle.scope, Exit.void),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );
    return SubagentCoordinator.of({ state, fibers, slots, scope });
  }),
);

export const activityOf = (handle: SubagentHandleState): SubagentActivity => {
  const activity: SubagentActivity = {
    parentSessionId: handle.parentSessionId,
    anchorPartId: handle.anchorPartId,
    handleId: handle.handleId,
    revision: handle.activityRevision,
    task: handle.task,
    profile: handle.profile,
    status: handle.status,
    resolvedModel: handle.resolvedModel,
    fastMode: handle.fastMode,
    retained: handle.retain,
    streaming: handle.streaming,
    parts: handle.parts,
  };
  if (handle.usage !== undefined) Object.assign(activity, { usage: handle.usage });
  if (handle.error !== undefined) Object.assign(activity, { error: handle.error });
  return activity;
};

export const updateHandle = (
  state: SubagentCoordinatorState,
  handleId: SubagentHandleId,
  update: (handle: SubagentHandleState) => SubagentHandleState,
): SubagentCoordinatorState => {
  const current = state.handles.get(handleId);
  if (!current) return state;
  const handles = new Map(state.handles);
  handles.set(handleId, update(current));
  return { revision: state.revision + 1, handles };
};

export const removeHandle = (
  state: SubagentCoordinatorState,
  handleId: SubagentHandleId,
): SubagentCoordinatorState => {
  if (!state.handles.has(handleId)) return state;
  const handles = new Map(state.handles);
  handles.delete(handleId);
  return { revision: state.revision + 1, handles };
};
