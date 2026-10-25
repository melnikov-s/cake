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
  Ref,
} from "effect";
import { SubagentStorage, type SubagentRecord } from "../storage/SubagentStorage";
import type { Deferred, Schema } from "effect";
import type { TaskInputReference } from "../../contracts/conversations/task-input";
import type { UiPart } from "../../contracts/conversations/session-contract";
import type { SubagentAttachmentAccess } from "../../contracts/subagents/subagent-attachments";
import type { SubagentMessageAccess } from "../../contracts/subagents/subagent-messages";
import type {
  CakeSessionRuntimeAcquireOptions,
  CakeSessionHandle,
} from "../pi/CakeSessionRuntimes";
import type {
  ResolvedAgentModel,
  SubagentActivity,
  SubagentError,
  SubagentHandleId,
  SubagentResult,
  SubagentStatus,
} from "../../contracts/subagents/subagent-data";

export interface SubagentHandleState {
  readonly handleId: SubagentHandleId;
  readonly recovery: SubagentRecord;
  readonly parentSessionId: string;
  readonly anchorPartId: string;
  readonly workingDirectory: string;
  readonly projectPath?: string;
  readonly task: string;
  readonly resolvedModel: ResolvedAgentModel;
  readonly tools: ReadonlyArray<string>;
  readonly instructions?: string;
  readonly fastMode: boolean;
  readonly scope: Scope.Closeable;
  readonly completion: Deferred.Deferred<SubagentResult, SubagentError>;
  readonly runtimeOptions: CakeSessionRuntimeAcquireOptions;
  readonly parentPiHandle?: CakeSessionHandle;
  /** Terminal workers acquire Pi resources only when their parent is observed or the handle is used. */
  readonly hydrate?: Effect.Effect<void, SubagentError>;
  readonly piHandle?: CakeSessionHandle;
  readonly privateSessionId?: string;
  readonly attachmentAccess?: SubagentAttachmentAccess;
  readonly inputReferences: readonly TaskInputReference[];
  readonly messageAccess?: SubagentMessageAccess;
  readonly messageReferences: readonly string[];
  readonly status: SubagentStatus;
  readonly activityRevision: number;
  readonly streaming: boolean;
  readonly parts: ReadonlyArray<Schema.Schema.Type<typeof Schema.Json>>;
  readonly usage?: Schema.Schema.Type<typeof Schema.Json>;
  readonly error?: string;
  readonly failurePhase?: "start";
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
  readonly storage: SubagentStorage["Service"];
  readonly checkpoints: Semaphore.Semaphore;
  readonly shuttingDown: Ref.Ref<boolean>;
}

/** Process-scoped resource owner; durable worker facts are checkpointed separately from Pi history. */
export class SubagentCoordinator extends Context.Service<
  SubagentCoordinator,
  SubagentCoordinatorService
>()("cake/services/subagents/SubagentCoordinator") {}

export const SubagentCoordinatorLive = Layer.effect(
  SubagentCoordinator,
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const storage = yield* SubagentStorage;
    const checkpoints = yield* Semaphore.make(1);
    const shuttingDown = yield* Ref.make(false);
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
        yield* Ref.set(shuttingDown, true);
        const current = yield* SubscriptionRef.get(state);
        yield* Effect.forEach(
          current.handles.values(),
          (handle) => Scope.close(handle.scope, Exit.void),
          { concurrency: "unbounded", discard: true },
        );
      }),
    );
    return SubagentCoordinator.of({
      state,
      fibers,
      slots,
      scope,
      storage,
      checkpoints,
      shuttingDown,
    });
  }),
);

export const queuedWorkerInputId = (turnId: string) => `worker-input:${turnId}`;

export const activityOf = (handle: SubagentHandleState): SubagentActivity => {
  const activity: SubagentActivity = {
    parentSessionId: handle.parentSessionId,
    anchorPartId: handle.anchorPartId,
    handleId: handle.handleId,
    revision: handle.activityRevision,
    task: handle.task,

    status: handle.status,
    resolvedModel: handle.resolvedModel,
    fastMode: handle.fastMode,
    streaming: handle.streaming,
    parts:
      handle.status === "queued"
        ? [
            ...handle.parts,
            ...handle.recovery.pendingInputs.slice(1).map((input): UiPart => ({
              id: queuedWorkerInputId(input.turnId),
              kind: "text",
              role: "user",
              text: input.text,
              status: "complete",
              deliveryState: "queued",
              ...(input.markdown ? { renderAs: "markdown" as const } : null),
              queuedInput: {
                itemId: input.turnId,
                turnId: input.turnId,
                text: input.text,
                attachments: [...input.attachments],
                renderUserMessageAsMarkdown: input.markdown,
              },
            })),
          ]
        : handle.parts,
  };
  if (handle.projectPath) Object.assign(activity, { projectPath: handle.projectPath });
  if (handle.failurePhase) Object.assign(activity, { failurePhase: handle.failurePhase });
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
