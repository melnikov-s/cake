import type { TurnStop } from "../../contracts/conversations/turn-stop";
import type { IdleCompactionResult } from "../../contracts/project-sessions/session-compaction";
import { sessionDigestReceiptIds } from "../../contracts/cake-chats/session-digest-reminder";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import {
  RuntimeRecoveryStorage,
  type RuntimeRecoveryInput,
} from "../storage/RuntimeRecoveryStorage";
import { stat } from "node:fs/promises";
import type { CakeOperationOptions } from "../../contracts/agent/cake-operation-options";
import {
  Context,
  Clock,
  Deferred,
  Effect,
  Equal,
  Exit,
  Hash,
  Layer,
  PubSub,
  RcMap,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Scope,
  Stream,
  Struct,
} from "effect";
import type {
  PiPendingMessageReorder,
  PiPendingMessages,
  PiQueuedMessages,
} from "../../contracts/conversations/pending-message-data";
import type { ArtifactPointer } from "../../contracts/artifacts/artifact-contract";
import {
  jsonValueSchema,
  type JsonObject,
  type JsonValue,
} from "../../contracts/serialization/json-contract";
import type {
  QueuedSessionCommandReceipt,
  SessionInspectionQuery,
} from "../../contracts/conversations/session-query-data";
import type {
  Attachment,
  UiPart,
  ChatConfiguration,
  PiSettingUpdate,
  PiSessionPreview,
  ConversationSnapshot,
  PiSessionSummary,
  ThinkingLevel,
} from "../../contracts/conversations/session-contract";
import {
  type CakeSessionRuntime,
  type CakeSessionRuntimeEvent,
  type CakeSessionRuntimeOptions,
} from "./runtime/cake-session-runtime";
import { subagentCompletionInput } from "../../contracts/subagents/subagent-report";
import { CakeChatDurable } from "../pi-durable/CakeChatDurable";
import { cakeChatSideChatConversationId } from "../../contracts/cake-chats/cake-chat-identity";
import { TurnCanceledError } from "./runtime/RuntimeTurnCompletion";
import {
  loadDurableArtifactReferences,
  loadPiChangelog,
  loadWorkspacePiSessionSummary,
  loadWorkspacePiSessionPreview,
  streamWorkspaceSessionIds,
  streamWorkspaceSessions,
} from "./runtime/session-discovery";
import type { ReviewParentContext } from "./runtime/sidecar-runtime";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import type { ConversationResponseMode } from "../../contracts/conversations/response-mode-reminders";
import type { PiTurnResult } from "../../contracts/pi/turn-result-data";

const PiSessionCapabilityProfile = Schema.TaggedUnion({
  ProjectSession: {},
  CakeChatSession: {},
  DiscussionSession: {},
  SubagentSession: {},
});
export const PiSessionQuery = Schema.Struct({
  workingDirectory: Schema.String,
  sessionDirectory: Schema.String,
  resolvedSessionDirectory: Schema.optionalKey(Schema.String),
  direct: Schema.optionalKey(Schema.Boolean),
  excludedSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  cakeChatSessionId: Schema.optionalKey(Schema.String),
});
export interface PiSessionQuery extends Schema.Schema.Type<typeof PiSessionQuery> {}

export const PiSessionTarget = Schema.Struct({
  workingDirectory: Schema.String,
  sessionId: Schema.String,
  sessionDirectory: Schema.String,
  resolvedSessionDirectory: Schema.optionalKey(Schema.String),
  direct: Schema.optionalKey(Schema.Boolean),
  cakeChatSessionId: Schema.optionalKey(Schema.String),
});
export interface PiSessionTarget extends Schema.Schema.Type<typeof PiSessionTarget> {}

export class PiSessionError extends Schema.TaggedError<PiSessionError>()("PiSessionError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export type PiSessionEvent =
  | Exclude<CakeSessionRuntimeEvent, { readonly type: "snapshot" }>
  | { readonly type: "snapshot-updated"; readonly snapshot: ConversationSnapshot }
  | {
      readonly type: "turn-accepted";
      readonly sessionId: string;
      readonly turnId: string;
      readonly delivery: "prompt" | "steer" | "follow-up";
    }
  | {
      readonly type: "turn-settled";
      readonly sessionId: string;
      readonly turnId: string;
      readonly outcome: "complete" | "failed" | "aborted";
      readonly message?: string;
    };

export type PiSessionUpdate =
  | { readonly _tag: "Snapshot"; readonly snapshot: ConversationSnapshot }
  | { readonly _tag: "Event"; readonly event: PiSessionEvent };

/** Cake composition inputs. The constructor consumes controls before entering the Pi runtime. */
export type CakeSessionRuntimeSetup = CakeSessionRuntimeOptions & CakeOperationOptions;

/**
 * Runtime construction is a Pi adapter concern. The semantic profile is
 * mandatory so callers cannot assemble Pi extension/tool policy ad hoc.
 */
export interface CakeSessionRuntimeAcquireOptions {
  readonly profile: Schema.Schema.Type<typeof PiSessionCapabilityProfile>;
  readonly runtime: Omit<
    CakeSessionRuntimeSetup,
    "onEvent" | "onTurnResult" | "onInitialTranscriptPersisted"
  >;
  /** Finalizes Cake-owned integrations when the final shared runtime lease is released. */
  readonly onRelease?: Effect.Effect<void, unknown>;
  readonly admitTurn?: (
    input: {
      readonly turnId: string;
      readonly text: string;
      readonly delivery: "prompt" | "steer" | "follow-up";
    },
    accept: Effect.Effect<void, PiSessionError>,
  ) => Effect.Effect<void, unknown>;
  readonly onTurnSettled?: (event: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly outcome: "complete" | "failed" | "aborted";
    readonly result?: PiTurnResult;
    readonly message?: string;
    /** Present only on an aborted turn that a user or agent deliberately stopped. */
    readonly stop?: TurnStop;
  }) => Effect.Effect<void, unknown>;
  /** Publishes lightweight activity after accepted turns start or settle. */
  readonly onTurnActivityChanged?: Effect.Effect<void>;
  /** Publishes kind-specific catalog metadata after shared conversation mutations. */
  readonly onSessionChanged?: Effect.Effect<void, unknown>;
}

export interface CakeSessionHandle {
  readonly currentTurnIds: () => Effect.Effect<ReadonlyArray<string>>;
  readonly recover: (
    inputs: ReadonlyArray<RuntimeRecoveryInput>,
    paused?: boolean,
  ) => Effect.Effect<void, PiSessionError>;
  /** Admit a new input with its owner's durable ID; unlike recover, this is explicit continuation. */
  readonly submit: (input: RuntimeRecoveryInput) => Effect.Effect<string, PiSessionError>;
  /** Permanent-chat receipt metadata; other profiles do not expose a digest inbox. */
  readonly admittedDigestIds?: () => Effect.Effect<ReadonlyArray<string>, PiSessionError>;
  readonly inputReceipt?: (
    turnId: string,
  ) => Effect.Effect<"consumed" | "canceled" | "pending" | undefined, PiSessionError>;
  readonly profile: CakeSessionRuntimeAcquireOptions["profile"]["_tag"];
  readonly updates: Stream.Stream<PiSessionUpdate, PiSessionError>;
  readonly snapshot: () => Effect.Effect<ConversationSnapshot, PiSessionError>;
  readonly prompt: (
    text: string,
    attachments?: ReadonlyArray<Attachment>,
    renderUserMessageAsMarkdown?: boolean,
    presentationMode?: ProjectSessionPresentationMode,
    automaticTitle?: boolean,
    responseMode?: ConversationResponseMode,
  ) => Effect.Effect<string, PiSessionError>;
  readonly steer: (
    text: string,
    attachments?: ReadonlyArray<Attachment>,
    renderUserMessageAsMarkdown?: boolean,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
  ) => Effect.Effect<string, PiSessionError>;
  readonly followUp: (
    text: string,
    attachments?: ReadonlyArray<Attachment>,
    renderUserMessageAsMarkdown?: boolean,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
  ) => Effect.Effect<string, PiSessionError>;
  readonly history?: (
    cursor: string,
  ) => Effect.Effect<{ parts: UiPart[]; cursor?: string }, PiSessionError>;
  readonly listQueuedMessages: () => Effect.Effect<PiQueuedMessages, PiSessionError>;
  readonly pendingMessages: () => Effect.Effect<PiPendingMessages, PiSessionError>;
  readonly reorderPendingMessage: (
    input: PiPendingMessageReorder,
  ) => Effect.Effect<PiPendingMessages, PiSessionError>;
  readonly clearQueue: () => Effect.Effect<PiQueuedMessages, PiSessionError>;
  readonly cancelSteering: () => Effect.Effect<PiQueuedMessages, PiSessionError>;
  readonly removeQueuedMessage: (partId: string) => Effect.Effect<PiQueuedMessages, PiSessionError>;
  readonly steerQueuedMessage: (partId: string) => Effect.Effect<PiQueuedMessages, PiSessionError>;
  readonly sendQueuedMessageNow: (
    partId?: string,
  ) => Effect.Effect<PiQueuedMessages, PiSessionError>;
  readonly editMessage: (
    entryId: string,
    text: string,
    attachments: ReadonlyArray<Attachment>,
    renderUserMessageAsMarkdown: boolean,
    presentationMode?: ProjectSessionPresentationMode,
    responseMode?: ConversationResponseMode,
  ) => Effect.Effect<void, PiSessionError>;
  readonly setUserMessageMarkdown: (
    entryId: string,
    renderAsMarkdown: boolean,
  ) => Effect.Effect<void, PiSessionError>;
  /** A `stop` attributes a deliberate stop; omitted, the abort is an unexpected interruption. */
  readonly abort: (stop?: TurnStop) => Effect.Effect<void, PiSessionError>;
  readonly queueCommand: (
    command: string,
  ) => Effect.Effect<QueuedSessionCommandReceipt, PiSessionError>;
  readonly inspectSession: (
    query: SessionInspectionQuery,
  ) => Effect.Effect<JsonValue, PiSessionError>;
  readonly executeCommand: (
    command: string,
    arguments_: string,
  ) => Effect.Effect<string | undefined, PiSessionError>;
  readonly applyConfiguration: (
    configuration: ChatConfiguration,
  ) => Effect.Effect<void, PiSessionError>;
  readonly setModel: (provider: string, modelId: string) => Effect.Effect<void, PiSessionError>;
  readonly setFastMode: (enabled: boolean) => Effect.Effect<void, PiSessionError>;
  readonly setThinkingLevel: (level: ThinkingLevel) => Effect.Effect<void, PiSessionError>;
  readonly setPiSetting: (update: PiSettingUpdate) => Effect.Effect<void, PiSessionError>;
  readonly navigate: (
    entryId: string,
    options: { readonly summarize: boolean; readonly customInstructions?: string },
  ) => Effect.Effect<void, PiSessionError>;
  readonly compact: (instructions?: string) => Effect.Effect<void, PiSessionError>;
  readonly compactMemory: () => Effect.Effect<void, PiSessionError>;
  readonly compactIfIdle: (
    instructions?: string,
  ) => Effect.Effect<IdleCompactionResult, PiSessionError>;
  readonly rename: (name: string, onlyIfUnnamed?: boolean) => Effect.Effect<void, PiSessionError>;
  readonly fork: (
    entryId: string,
    title: string,
  ) => Effect.Effect<
    {
      readonly sessionId: string;
      readonly sessionFile: string;
      readonly artifactPointers: ReadonlyArray<ArtifactPointer>;
    },
    PiSessionError
  >;
  readonly toolCompact: (
    entryId: string,
  ) => Effect.Effect<{ readonly sessionId: string; readonly sessionFile: string }, PiSessionError>;
  readonly reviewParentContext: () => Effect.Effect<ReviewParentContext, PiSessionError>;
  readonly notifySubagentCompletion: (
    result: Schema.Schema.Type<typeof Schema.Json>,
    completionId?: string,
  ) => Effect.Effect<void, PiSessionError>;
  readonly reload: () => Effect.Effect<void, PiSessionError>;
  readonly publishSessionChanged: () => Effect.Effect<void, PiSessionError>;
  readonly callCakeOperation: (
    command: string,
    input: JsonObject,
  ) => Effect.Effect<JsonValue, PiSessionError>;
  readonly dispatchExtensionCompanionAction: (
    id: string,
    action: string,
    value: Schema.Schema.Type<typeof Schema.Json>,
  ) => Effect.Effect<void, PiSessionError>;
}

export interface CakeSessionRuntimeStatus {
  /** Start of the current accepted/executing stretch, not transcript modification time. */
  readonly workingStartedAt?: number;
  readonly recoveryIssue?: string;
  readonly latestTurnOutcome?: "complete" | "failed" | "aborted";
  readonly streaming: boolean;
  readonly pending: boolean;
  readonly persisted: boolean;
}

export interface CakeSessionRuntimesAdapter {
  readonly sessionIds: (query: PiSessionQuery) => Stream.Stream<string, unknown>;
  readonly catalog: (query: PiSessionQuery) => Stream.Stream<PiSessionSummary, unknown>;
  readonly catalogEntry: (
    query: PiSessionQuery,
    sessionId: string,
  ) => Effect.Effect<PiSessionSummary | undefined, unknown>;
  readonly inspect: (
    target: PiSessionTarget,
    options?: { readonly includeParts?: boolean },
  ) => Effect.Effect<PiSessionPreview | undefined, unknown>;
  readonly createRuntime: (
    options: CakeSessionRuntimeSetup,
  ) => Effect.Effect<CakeSessionRuntime, unknown>;
  readonly changelog: () => Effect.Effect<string, unknown>;
  readonly durableArtifactReferences?: (
    sessionRoots: ReadonlyArray<string>,
  ) => Effect.Effect<
    { readonly sessionIds: ReadonlyArray<string>; readonly lineageIds: ReadonlyArray<string> },
    unknown
  >;
}

export class CakeSessionRuntimes extends Context.Service<
  CakeSessionRuntimes,
  {
    readonly sessionIds: (query: PiSessionQuery) => Stream.Stream<string, PiSessionError>;
    readonly catalog: (query: PiSessionQuery) => Stream.Stream<PiSessionSummary, PiSessionError>;
    readonly catalogEntry: (
      query: PiSessionQuery,
      sessionId: string,
    ) => Effect.Effect<PiSessionSummary | undefined, PiSessionError>;
    readonly inspect: (
      target: PiSessionTarget,
      options?: { readonly includeParts?: boolean },
    ) => Effect.Effect<PiSessionPreview, PiSessionError>;
    readonly acquire: (
      options: CakeSessionRuntimeAcquireOptions,
    ) => Effect.Effect<CakeSessionHandle, PiSessionError, Scope.Scope>;
    readonly acquireCurrent: (
      target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
    ) => Effect.Effect<CakeSessionHandle, PiSessionError, Scope.Scope>;
    /** Acquires an assembled primary-session runtime by its globally unique Pi Session ID. */
    readonly acquireSession: (
      sessionId: string,
    ) => Effect.Effect<CakeSessionHandle, PiSessionError, Scope.Scope>;
    /** Tests runtime presence without loading history, recovery state, or acquiring a lease. */
    readonly hasCurrent: (
      target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
    ) => Effect.Effect<boolean>;
    /** Reads an already-acquired runtime without constructing or retaining one. */
    readonly currentStatus: (
      target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
    ) => Effect.Effect<CakeSessionRuntimeStatus | undefined>;
    /** Last transcript write of an already-acquired runtime: one stat, never a transcript parse. */
    readonly currentModifiedAt: (
      target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
    ) => Effect.Effect<string | undefined>;
    readonly currentTurnIds: (
      target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
    ) => Effect.Effect<ReadonlyArray<string>>;
    readonly executingTurnIds: (
      target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
    ) => Effect.Effect<ReadonlyArray<string>>;
    /** Called after permanent session/worker deletion, never on ordinary runtime release. */
    readonly forgetRecovery: (sessionId: string) => Effect.Effect<void, PiSessionError>;
    readonly refreshModels: () => Effect.Effect<void, PiSessionError>;
    readonly reloadWorkingDirectory: (
      workingDirectory: string,
    ) => Effect.Effect<void, PiSessionError>;
    readonly reloadAll: () => Effect.Effect<void, PiSessionError>;
    readonly reloadCakeChatContext: () => Effect.Effect<void, PiSessionError>;
    /** Reads durable pointers from every Pi Session under the supplied roots. */
    readonly durableArtifactReferences: (
      sessionRoots: ReadonlyArray<string>,
    ) => Effect.Effect<
      { readonly sessionIds: ReadonlyArray<string>; readonly lineageIds: ReadonlyArray<string> },
      PiSessionError
    >;
  }
>()("cake/services/pi/CakeSessionRuntimes") {}

interface SharedRuntime {
  applicationLease: boolean;
  readonly fingerprint: string;
  readonly workingDirectory: string;
  readonly sessionDirectory: string;
  readonly profile: CakeSessionRuntimeAcquireOptions["profile"]["_tag"];
  readonly runtime: CakeSessionRuntime;
  readonly events: PubSub.PubSub<PiSessionEvent>;
  readonly initialTranscriptPersisted: Deferred.Deferred<void>;
  readonly activeTurns: Ref.Ref<ReadonlyMap<string, "prompt" | "steer" | "follow-up">>;
  readonly activityTiming: { startedAt: number | undefined };
  readonly settledInputIds: Set<string>;
  readonly turnResults: Map<string, PiTurnResult>;
  readonly queueEdits: Semaphore.Semaphore;
  readonly turnAdmissions: Semaphore.Semaphore;
}

class RuntimeKey implements Equal.Equal {
  readonly fingerprint: string;
  constructor(
    readonly target: string,
    readonly options: CakeSessionRuntimeAcquireOptions,
  ) {
    this.fingerprint = runtimeFingerprint(options);
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof RuntimeKey && this.target === that.target;
  }
  [Hash.symbol](): number {
    return Hash.string(this.target);
  }
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const sessionError = (operation: string) =>
  Effect.mapError((cause: unknown) => new PiSessionError({ operation, message: messageOf(cause) }));

const sessionErrorValue = (operation: string) => (cause: unknown) =>
  new PiSessionError({ operation, message: messageOf(cause) });

const runtimeTarget = (options: CakeSessionRuntimeAcquireOptions): string => {
  const runtime = options.runtime;
  const identity =
    runtime.sessionId ?? runtime.sessionFile ?? (runtime.newSession ? "new" : "recent");
  return `${runtime.cwd}\u0000${runtime.sessionDir}\u0000${identity}`;
};

const runtimeFingerprint = (options: CakeSessionRuntimeAcquireOptions): string => {
  const runtime = options.runtime;
  return JSON.stringify({
    profile: options.profile,
    cwd: runtime.cwd,
    agentDir: runtime.agentDir,
    sessionDir: runtime.sessionDir,
    directSessionDir: runtime.directSessionDir ?? false,
    // Once a caller creates an explicit session ID, later open/command
    // acquisitions address that same runtime. Creation mode is not a lasting
    // runtime policy and therefore is not part of the conflict fingerprint.
    sessionId: runtime.sessionId,
    sessionFile: runtime.sessionFile,
    trusted: runtime.trusted,
    tools: runtime.tools ? [...runtime.tools].sort() : undefined,
    auxiliary: runtime.auxiliary ?? false,
    ephemeral: runtime.ephemeral ?? false,
    projectInvestigation: runtime.projectInvestigation ?? false,
    allowMutations: runtime.allowMutations ?? false,
    auxiliaryProjectResources: runtime.auxiliaryProjectResources ?? false,
    alwaysAutoCompact: runtime.alwaysAutoCompact ?? false,
    isolatedSystemPrompt: runtime.isolatedSystemPrompt,
    slashCommands: runtime.slashCommands,
    // Relationship context is regenerated on acquisition and may change when a
    // standalone session is promoted. It does not redefine the live Pi runtime.
    hasGlobalControl: runtime.globalControl !== undefined,
    hasSessionControl: runtime.sessionControl !== undefined,
    hasAgentControl: runtime.agentControl !== undefined,
  });
};

const validateProfile = Effect.fn("CakeSessionRuntimes.validateProfile")(function* (
  options: CakeSessionRuntimeAcquireOptions,
) {
  const decoded = yield* Schema.decodeUnknownEffect(PiSessionCapabilityProfile)(
    options.profile,
  ).pipe(sessionError("acquire"));
  const profile = decoded._tag;
  const runtime = options.runtime;
  const valid =
    (profile === "ProjectSession" &&
      !runtime.auxiliary &&
      !runtime.globalControl &&
      !runtime.sessionControl) ||
    (profile === "CakeChatSession" &&
      runtime.globalControl !== undefined &&
      !runtime.auxiliary &&
      !runtime.sessionControl) ||
    (profile === "DiscussionSession" &&
      runtime.auxiliary === true &&
      runtime.globalControl === undefined) ||
    (profile === "SubagentSession" &&
      runtime.auxiliary === true &&
      runtime.globalControl === undefined &&
      runtime.sessionControl === undefined);
  if (valid && (!runtime.projectInvestigation || profile === "SubagentSession")) return;
  return yield* new PiSessionError({
    operation: "acquire",
    message: `Runtime options conflict with the ${profile} capability profile`,
  });
});

const runtimeOperation = <A>(operation: string, evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(sessionError(operation));

const cancellableRuntimeOperation = <A>(
  operation: string,
  evaluate: (signal: AbortSignal) => Promise<A>,
) => Effect.tryPromise({ try: evaluate, catch: (cause) => cause }).pipe(sessionError(operation));

export const makeCakeSessionRuntimesLayer = (adapter: CakeSessionRuntimesAdapter) =>
  Layer.effect(
    CakeSessionRuntimes,
    Effect.gen(function* () {
      const layerScope = yield* Effect.scope;
      const clock = yield* Clock.Clock;
      const recoveryStorage = yield* RuntimeRecoveryStorage;
      const recoveryGate = yield* Semaphore.make(1);
      const persistInput = Effect.fn("CakeSessionRuntimes.persistInput")(function* (
        shared: SharedRuntime,
        input: RuntimeRecoveryInput,
        paused = false,
      ) {
        const profile = shared.profile;
        if (profile === "DiscussionSession") return;
        const persisted = yield* Effect.promise(() =>
          stat(shared.runtime.sessionFile).then(
            () => true,
            () => false,
          ),
        );
        yield* recoveryGate.withPermit(
          Effect.gen(function* () {
            const previous = yield* recoveryStorage.get(shared.runtime.sessionId);
            yield* recoveryStorage.update({
              sessionId: shared.runtime.sessionId,
              workingDirectory: shared.workingDirectory,
              sessionDirectory: shared.sessionDirectory,
              profile,
              transcriptPersisted: previous?.transcriptPersisted || persisted,
              canceledInputIds: previous?.canceledInputIds ?? [],
              deliveredDigestIds: [
                ...new Set([
                  ...(previous?.deliveredDigestIds ?? []),
                  ...sessionDigestReceiptIds(input.text),
                ]),
              ],
              state: previous?.state === "blocked" ? "blocked" : paused ? "stopped" : "active",
              ...(previous?.state === "blocked" && previous.issue
                ? { issue: previous.issue }
                : null),
              inputs: [
                ...(previous?.inputs ?? []).filter((item) => item.turnId !== input.turnId),
                input,
              ],
            });
          }),
        );
      });
      const removeRecoveryInput = Effect.fn("CakeSessionRuntimes.removeRecoveryInput")(function* (
        sessionId: string,
        turnId: string,
        outcome: "complete" | "failed" | "aborted",
      ) {
        yield* recoveryGate.withPermit(
          Effect.gen(function* () {
            const record = yield* recoveryStorage.get(sessionId);
            if (!record?.inputs.some((item) => item.turnId === turnId)) return;
            const inputs = record.inputs.filter((item) => item.turnId !== turnId);
            const canceledInputIds =
              outcome === "aborted"
                ? [...new Set([...(record.canceledInputIds ?? []), turnId])]
                : record.canceledInputIds;
            yield* recoveryStorage.update({
              ...record,
              inputs,
              ...(canceledInputIds ? { canceledInputIds } : null),
              // Withdrawing an input does not stop the session. Only an explicit
              // stop pauses remaining recovery work, including later settlements.
              state:
                inputs.length || record.state === "stopped"
                  ? record.state
                  : outcome === "aborted"
                    ? "complete"
                    : outcome,
            });
          }),
        );
      });
      // RcMap remains the sole resource owner. This set is only a process-local projection used
      // to fan explicit refresh intents to currently acquired runtimes; it never acquires or
      // retains a runtime.
      const activeRuntimes = new Set<SharedRuntime>();
      const acquiredOptions = new Map<string, CakeSessionRuntimeAcquireOptions>();
      // RcMap is the process-local keyed resource owner. Each acquire retains a
      // reference in its caller Scope; the final release disposes the one Pi
      // runtime. Equal/Hash intentionally key only by Pi Session target, while
      // the fingerprint below rejects conflicting runtime-defining options.
      const runtimes = yield* RcMap.make({
        lookup: (key: RuntimeKey) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const events = yield* PubSub.unbounded<PiSessionEvent>();
              const activityEvents = yield* PubSub.subscribe(events);
              yield* Stream.fromSubscription(activityEvents).pipe(
                Stream.filter((event) => event.type === "streaming"),
                Stream.runForEach(() => key.options.onTurnActivityChanged ?? Effect.void),
                Effect.forkScoped,
              );
              const activeTurns = yield* Ref.make<
                ReadonlyMap<string, "prompt" | "steer" | "follow-up">
              >(new Map());
              const settledInputIds = new Set<string>();
              const activityTiming: SharedRuntime["activityTiming"] = { startedAt: undefined };
              const turnResults = new Map<string, PiTurnResult>();
              const initialTranscriptPersisted = yield* Deferred.make<void>();
              if (key.options.profile._tag === "ProjectSession" && key.options.runtime.newSession)
                yield* Deferred.await(initialTranscriptPersisted).pipe(
                  Effect.andThen(key.options.onSessionChanged ?? Effect.void),
                  Effect.orDie,
                  Effect.forkScoped,
                );
              let currentRuntime: CakeSessionRuntime | undefined = undefined;
              const runtime = yield* adapter.createRuntime({
                ...key.options.runtime,
                onInitialTranscriptPersisted() {
                  Deferred.doneUnsafe(initialTranscriptPersisted, Effect.void);
                },
                onTurnResult(turnId, result) {
                  turnResults.set(turnId, result);
                },
                onEvent(event) {
                  if (event.type === "streaming") {
                    if (event.streaming)
                      activityTiming.startedAt ??= clock.currentTimeMillisUnsafe();
                    else {
                      for (const id of currentRuntime?.executingTurnIds?.() ?? [])
                        settledInputIds.add(id);
                      if (
                        ![...Ref.getUnsafe(activeTurns)].some(
                          ([id, delivery]) => delivery !== "follow-up" && !settledInputIds.has(id),
                        )
                      )
                        activityTiming.startedAt = undefined;
                    }
                  }
                  const projected: PiSessionEvent =
                    event.type === "snapshot"
                      ? { type: "snapshot-updated", snapshot: event.snapshot }
                      : event;
                  PubSub.publishUnsafe(events, projected);
                },
              });
              currentRuntime = runtime;
              if (
                key.options.runtime.newSession &&
                key.options.profile._tag !== "DiscussionSession"
              )
                yield* Deferred.await(initialTranscriptPersisted).pipe(
                  Effect.andThen(
                    recoveryGate.withPermit(
                      Effect.gen(function* () {
                        const record = yield* recoveryStorage.get(runtime.sessionId);
                        if (record && !record.transcriptPersisted)
                          yield* recoveryStorage.update({ ...record, transcriptPersisted: true });
                      }),
                    ),
                  ),
                  Effect.orDie,
                  Effect.forkScoped,
                );
              const shared: SharedRuntime = {
                applicationLease: false,
                initialTranscriptPersisted,
                settledInputIds,
                turnResults,
                fingerprint: key.fingerprint,
                workingDirectory: key.options.runtime.cwd,
                sessionDirectory: key.options.runtime.sessionDir,
                profile: key.options.profile._tag,
                runtime,
                events,
                activeTurns,
                activityTiming,
                queueEdits: Semaphore.makeUnsafe(1),
                turnAdmissions: Semaphore.makeUnsafe(1),
              };
              activeRuntimes.add(shared);
              acquiredOptions.set(runtimeTarget(key.options), key.options);
              acquiredOptions.set(
                `${key.options.runtime.cwd}\u0000${key.options.runtime.sessionDir}\u0000${runtime.sessionId}`,
                key.options,
              );
              return shared;
            }),
            (shared) =>
              Effect.tryPromise({
                try: async () => {
                  activeRuntimes.delete(shared);
                  for (const [target, options] of acquiredOptions)
                    if (runtimeTarget(options) === runtimeTarget(key.options))
                      acquiredOptions.delete(target);
                  await shared.runtime.dispose();
                },
                catch: (cause) => cause,
              }).pipe(
                Effect.orDie,
                Effect.ensuring((key.options.onRelease ?? Effect.void).pipe(Effect.orDie)),
                Effect.ensuring(PubSub.shutdown(shared.events)),
              ),
          ),
      });

      const sessionIds = (query: PiSessionQuery) =>
        Stream.unwrap(
          Schema.decodeUnknownEffect(PiSessionQuery)(query).pipe(
            sessionError("sessionIds"),
            Effect.map((decoded) =>
              adapter
                .sessionIds(decoded)
                .pipe(Stream.mapError(messageOf), Stream.mapError(sessionErrorValue("sessionIds"))),
            ),
          ),
        );

      const catalog = (query: PiSessionQuery) =>
        Stream.unwrap(
          Schema.decodeUnknownEffect(PiSessionQuery)(query).pipe(
            sessionError("catalog"),
            Effect.map((decoded) =>
              adapter
                .catalog(decoded)
                .pipe(Stream.mapError(messageOf), Stream.mapError(sessionErrorValue("catalog"))),
            ),
          ),
        );

      const inspect = Effect.fn("CakeSessionRuntimes.inspect")(function* (
        target: PiSessionTarget,
        options?: { readonly includeParts?: boolean },
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(PiSessionTarget)(target).pipe(
          sessionError("inspect"),
        );
        const preview = yield* adapter.inspect(decoded, options).pipe(sessionError("inspect"));
        if (preview) return preview;
        return yield* new PiSessionError({
          operation: "inspect",
          message: `Pi Session ${decoded.sessionId} was not found`,
        });
      });

      const catalogEntry = Effect.fn("CakeSessionRuntimes.catalogEntry")(function* (
        query: PiSessionQuery,
        sessionId: string,
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(PiSessionQuery)(query).pipe(
          sessionError("catalogEntry"),
        );
        return yield* adapter.catalogEntry(decoded, sessionId).pipe(sessionError("catalogEntry"));
      });

      const acquire = Effect.fn("CakeSessionRuntimes.acquire")(function* (
        options: CakeSessionRuntimeAcquireOptions,
      ) {
        yield* validateProfile(options);
        const key = new RuntimeKey(runtimeTarget(options), options);
        const ownerScope = yield* Effect.scope;
        const shared = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // Retain through a private lease Scope until the options have been
            // checked. A rejected acquisition must not leave a reference in the
            // caller's longer-lived Scope.
            const leaseScope = yield* Scope.make();
            const retained = yield* restore(
              RcMap.get(runtimes, key).pipe(
                Effect.provideService(Scope.Scope, leaseScope),
                sessionError("acquire"),
              ),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(leaseScope, Exit.void) : Effect.void,
              ),
            );
            if (retained.fingerprint !== key.fingerprint) {
              yield* Scope.close(leaseScope, Exit.void);
              return yield* new PiSessionError({
                operation: "acquire",
                message: "That Pi Session is already acquired with conflicting runtime options",
              });
            }
            yield* Scope.addFinalizer(ownerScope, Scope.close(leaseScope, Exit.void));
            // The permanent coordinator belongs to the application, not its visible pane.
            // Keep one ordinary RcMap lease so worker reports can wake it after observers leave.
            if (retained.profile === "CakeChatSession" && !retained.applicationLease) {
              retained.applicationLease = true;
              yield* RcMap.get(runtimes, key).pipe(
                Effect.provideService(Scope.Scope, layerScope),
                sessionError("acquire"),
              );
            }
            return retained;
          }),
        );

        const call = <A>(
          operation: string,
          evaluate: (runtime: CakeSessionRuntime) => Promise<A>,
        ) => runtimeOperation(operation, () => evaluate(shared.runtime));
        const snapshot = Effect.fn("CakeSessionRuntimes.recoverySnapshot")(function* () {
          const value = yield* call("snapshot", (runtime) => runtime.snapshot());
          const recovered = yield* recoveryStorage.get(value.sessionId).pipe(Effect.result);
          const record = recovered._tag === "Success" ? recovered.success : undefined;
          const issue =
            recovered._tag === "Failure"
              ? recovered.failure.message
              : record?.state === "blocked"
                ? (record.issue ?? "Cannot resume this session")
                : undefined;
          if (!issue) return value;
          return {
            ...value,
            parts: [
              ...value.parts.filter((part) => part.id !== "restart-recovery"),
              {
                id: "restart-recovery",
                kind: "notice" as const,
                tone: "error" as const,
                title:
                  recovered._tag === "Failure"
                    ? "Recovery metadata needs repair"
                    : "Cannot resume session",
                detail: issue,
              },
            ],
          };
        });
        // Whole-queue replacements from every acquired handle share one runtime gate.
        // Never hold this gate for an executing prompt or send-now's new turn.
        const editQueue = Effect.fn("CakeSessionRuntimes.editQueue")(function* <A>(
          operation: string,
          evaluate: (runtime: CakeSessionRuntime) => Promise<A>,
        ) {
          const before = shared.runtime.pendingRecoveryInputs?.();
          const result = yield* call(operation, evaluate);
          const after = shared.runtime.pendingRecoveryInputs?.();
          if (before && after)
            yield* recoveryGate
              .withPermit(
                Effect.gen(function* () {
                  const record = yield* recoveryStorage.get(shared.runtime.sessionId);
                  if (!record) return;
                  const cancelled = before
                    .filter(
                      (item) =>
                        !after.some((next) => next.turnId === item.turnId) &&
                        !shared.runtime.hasConsumedInput?.(item.turnId),
                    )
                    .map((item) => item.turnId);
                  const retained = record.inputs.filter((item) => !cancelled.includes(item.turnId));
                  const pendingIds = after.map((item) => item.turnId);
                  const inputs = [
                    ...retained.filter((item) => !pendingIds.includes(item.turnId)),
                    ...after.flatMap((queued) => {
                      const input = retained.find((item) => item.turnId === queued.turnId);
                      return input ? [{ ...input, delivery: queued.delivery }] : [];
                    }),
                  ];
                  yield* recoveryStorage.update({
                    ...record,
                    inputs,
                    canceledInputIds: [
                      ...new Set([...(record.canceledInputIds ?? []), ...cancelled]),
                    ],
                  });
                }),
              )
              .pipe(sessionError(operation));
          return result;
        }, shared.queueEdits.withPermit);
        const updates = Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading the snapshot. Runtime events produced
            // while Pi builds the snapshot are buffered by this subscription,
            // eliminating the initial snapshot/live-event gap.
            const subscription = yield* PubSub.subscribe(shared.events);
            const initial = yield* snapshot();
            return Stream.make({ _tag: "Snapshot" as const, snapshot: initial }).pipe(
              Stream.concat(
                Stream.fromEffect(PubSub.take(subscription)).pipe(
                  Stream.repeat(Schedule.forever),
                  Stream.map((event): PiSessionUpdate => ({ _tag: "Event", event })),
                ),
              ),
            );
          }),
        );

        const startTurn = Effect.fn("CakeSessionRuntimes.startTurn")(function* (
          delivery: "prompt" | "steer" | "follow-up",
          text: string,
          attachments: ReadonlyArray<Attachment>,
          markdown = false,
          presentationMode?: ProjectSessionPresentationMode,
          automaticTitle?: boolean,
          responseMode?: ConversationResponseMode,
          recovered?: RuntimeRecoveryInput,
          paused = false,
          admissionId?: string,
          internal = recovered?.internal,
        ) {
          const coordination = parseCrossSessionMessage(text);
          const turnId =
            recovered?.turnId ??
            admissionId ??
            coordination?.metadata.messageId ??
            crypto.randomUUID();
          if (
            (yield* Ref.get(shared.activeTurns)).has(turnId) ||
            shared.settledInputIds.has(turnId)
          )
            return turnId;
          if (!recovered && (coordination || admissionId)) {
            if (shared.runtime.hasConsumedInput?.(turnId)) return turnId;
            const record = yield* recoveryStorage
              .get(shared.runtime.sessionId)
              .pipe(sessionError(delivery));
            if (
              record?.inputs.some((input) => input.turnId === turnId) ||
              record?.canceledInputIds?.includes(turnId)
            )
              return turnId;
            if (
              record?.state === "blocked" ||
              (record?.state === "stopped" && record.inputs.length > 0)
            )
              return yield* new PiSessionError({
                operation: delivery,
                message: "This session needs user input before accepting more automatic work",
              });
          }
          const turnScope = yield* Scope.make();
          const retained = yield* RcMap.get(runtimes, key).pipe(
            Effect.provideService(Scope.Scope, turnScope),
            sessionError(delivery),
          );
          const settle = Effect.fn("CakeSessionRuntimes.settleTurn")(function* (
            outcome: "complete" | "failed" | "aborted",
            message?: string,
          ) {
            const active = yield* Ref.modify(retained.activeTurns, (turns) => {
              if (!turns.has(turnId)) return [false, turns] as const;
              const next = new Map(turns);
              next.delete(turnId);
              return [true, next] as const;
            });
            retained.settledInputIds.add(turnId);
            const result = retained.turnResults.get(turnId);
            retained.turnResults.delete(turnId);
            // A run whose final response errored or was cut off at a token limit never
            // produced a final answer, even though Pi's prompt resolved normally.
            const unfinished = result?.stopReason === "error" || result?.stopReason === "length";
            const settledOutcome =
              outcome !== "complete"
                ? outcome
                : unfinished
                  ? "failed"
                  : result?.stopReason === "aborted"
                    ? "aborted"
                    : outcome;
            const settledMessage =
              message ?? (outcome === "complete" && unfinished ? result.errorMessage : undefined);
            if (active) {
              const event: PiSessionEvent = {
                type: "turn-settled",
                sessionId: retained.runtime.sessionId,
                turnId,
                outcome: settledOutcome,
              };
              if (settledMessage !== undefined) Object.assign(event, { message: settledMessage });
              // Settle the authoritative journal before callbacks can wait on
              // report delivery while a newer turn runs and succeeds.
              yield* removeRecoveryInput(retained.runtime.sessionId, turnId, settledOutcome).pipe(
                Effect.orDie,
              );
              yield* PubSub.publish(retained.events, event);
              yield* key.options.onTurnActivityChanged ?? Effect.void;
              if (key.options.onTurnSettled)
                yield* key.options.onTurnSettled({
                  sessionId: retained.runtime.sessionId,
                  turnId,
                  outcome: settledOutcome,
                  ...(result ? { result } : null),
                  ...(settledMessage ? { message: settledMessage } : null),
                });
            }
            retained.settledInputIds.delete(turnId);
          });
          const finished = yield* Deferred.make<void, PiSessionError>();
          // Input the user withdrew (abort, removed queue row, cleared queue) is a
          // cancellation of accepted work, not a failure of the session.
          const run = Effect.tryPromise({
            try: () =>
              paused && retained.runtime.restoreInput
                ? retained.runtime.restoreInput(
                    recovered ?? {
                      turnId,
                      text,
                      delivery,
                      attachments: [...attachments],
                      markdown,
                    },
                  )
                : recovered && retained.runtime.recoverInput
                  ? retained.runtime.recoverInput(recovered)
                  : retained.runtime.prompt(
                      text,
                      delivery,
                      [...attachments],
                      markdown,
                      turnId,
                      presentationMode,
                      automaticTitle,
                      responseMode,
                      internal,
                    ),
            catch: (cause) => cause,
          }).pipe(
            Effect.matchEffect({
              onSuccess: () => settle("complete"),
              onFailure: (cause) =>
                (cause instanceof TurnCanceledError
                  ? settle("aborted")
                  : settle("failed", messageOf(cause))
                ).pipe(
                  Effect.andThen(
                    Deferred.fail(
                      finished,
                      new PiSessionError({ operation: delivery, message: messageOf(cause) }),
                    ),
                  ),
                ),
            }),
            Effect.ensuring(Scope.close(turnScope, Exit.void)),
          );
          const accept = Effect.gen(function* () {
            yield* persistInput(
              retained,
              {
                turnId,
                text,
                delivery,
                attachments: [...attachments],
                markdown,
                ...(internal === undefined ? null : { internal }),
                ...(presentationMode === undefined ? null : { presentationMode }),
                ...(responseMode === undefined ? null : { responseMode }),
                ...(automaticTitle === undefined ? null : { automaticTitle }),
              },
              paused,
            ).pipe(sessionError(delivery));
            if (delivery !== "follow-up") {
              const alreadyWorking =
                retained.runtime.streaming ||
                [...(yield* Ref.get(retained.activeTurns))].some(
                  ([id, kind]) => kind !== "follow-up" && !retained.settledInputIds.has(id),
                );
              if (!alreadyWorking)
                retained.activityTiming.startedAt = clock.currentTimeMillisUnsafe();
            }
            yield* Ref.update(retained.activeTurns, (turns) =>
              new Map(turns).set(turnId, delivery),
            );
            yield* PubSub.publish(retained.events, {
              type: "turn-accepted",
              sessionId: retained.runtime.sessionId,
              turnId,
              delivery,
            });
            yield* options.onTurnActivityChanged ?? Effect.void;
            yield* run.pipe(
              Effect.ensuring(Deferred.succeed(finished, undefined)),
              Effect.forkIn(layerScope),
            );
          });
          yield* (
            options.admitTurn ? options.admitTurn({ turnId, text, delivery }, accept) : accept
          ).pipe(
            Effect.mapError(
              (cause) => new PiSessionError({ operation: delivery, message: String(cause) }),
            ),
            Effect.onExit((exit) =>
              Exit.isFailure(exit) ? Scope.close(turnScope, Exit.void) : Effect.void,
            ),
          );
          if (options.profile._tag === "ProjectSession" && options.runtime.newSession) {
            // A new identity becomes discoverable at the first durable message, not
            // turn acceptance. Handled commands can finish without a conversation;
            // failed preparation must fail creation rather than leave a ghost identity.
            yield* Deferred.await(retained.initialTranscriptPersisted).pipe(
              Effect.raceFirst(Deferred.await(finished)),
            );
          }
          const persisted = yield* Effect.promise(() =>
            stat(retained.runtime.sessionFile).then(
              () => true,
              () => false,
            ),
          );
          if (persisted)
            yield* recoveryGate
              .withPermit(
                Effect.gen(function* () {
                  const record = yield* recoveryStorage.get(retained.runtime.sessionId);
                  if (record && !record.transcriptPersisted)
                    yield* recoveryStorage.update({ ...record, transcriptPersisted: true });
                }),
              )
              .pipe(sessionError(delivery));
          return turnId;
        }, shared.turnAdmissions.withPermit);

        const claimAbortedTurns = Effect.fn("CakeSessionRuntimes.claimAbortedTurns")(function* (
          turnIds: ReadonlyArray<string>,
        ) {
          return yield* Ref.modify(shared.activeTurns, (turns) => {
            const claimed = turnIds.filter((turnId) => turns.has(turnId));
            const next = new Map(turns);
            for (const turnId of claimed) next.delete(turnId);
            return [claimed, next] as const;
          });
        });

        const settleAbortedTurns = Effect.fn("CakeSessionRuntimes.settleAbortedTurns")(function* (
          turnIds: ReadonlyArray<string>,
          stop: TurnStop | undefined,
        ) {
          yield* Effect.forEach(
            turnIds,
            (turnId) =>
              Effect.gen(function* () {
                shared.settledInputIds.delete(turnId);
                shared.turnResults.delete(turnId);
                yield* removeRecoveryInput(shared.runtime.sessionId, turnId, "aborted").pipe(
                  sessionError("abort"),
                );
                yield* PubSub.publish(shared.events, {
                  type: "turn-settled",
                  sessionId: shared.runtime.sessionId,
                  turnId,
                  outcome: "aborted",
                });
                yield* options.onTurnActivityChanged ?? Effect.void;
                if (options.onTurnSettled)
                  yield* options
                    .onTurnSettled({
                      sessionId: shared.runtime.sessionId,
                      turnId,
                      outcome: "aborted",
                      ...(stop ? { stop } : null),
                    })
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new PiSessionError({ operation: "abort", message: String(cause) }),
                      ),
                    );
              }),
            { discard: true },
          );
        });

        const recoverInputs = Effect.fn("CakeSessionRuntimes.recoverInputs")(function* (
          inputs: ReadonlyArray<RuntimeRecoveryInput>,
          paused = false,
        ) {
          yield* recoveryGate
            .withPermit(
              Effect.gen(function* () {
                const record = yield* recoveryStorage.get(shared.runtime.sessionId);
                if (record?.state === "blocked")
                  yield* recoveryStorage.update({
                    ...Struct.omit(record, ["issue"]),
                    state: paused ? "stopped" : "active",
                  });
              }),
            )
            .pipe(sessionError("recover"));
          for (const input of inputs)
            yield* startTurn(
              paused ? "follow-up" : input.delivery,
              input.text,
              input.attachments,
              input.markdown,
              input.presentationMode,
              input.automaticTitle,
              input.responseMode,
              input,
              paused,
            );
        });

        const deliverInput = Effect.fn("CakeSessionRuntimes.deliverInput")(function* (
          delivery: "prompt" | "steer" | "follow-up",
          text: string,
          attachments: ReadonlyArray<Attachment>,
          markdown = false,
          presentationMode?: ProjectSessionPresentationMode,
          automaticTitle?: boolean,
          responseMode?: ConversationResponseMode,
          admissionId?: string,
          internal?: RuntimeRecoveryInput["internal"],
        ) {
          const record = yield* recoveryStorage
            .get(shared.runtime.sessionId)
            .pipe(sessionError(delivery));
          if (
            record?.state === "blocked" &&
            (!internal || internal._tag === "UserWithReminders") &&
            !parseCrossSessionMessage(text)
          ) {
            // Continue the original turns and their reporting obligations. A
            // continuation is not a user stop and must not publish an abort.
            yield* recoverInputs(record.inputs);
          }
          return yield* startTurn(
            delivery,
            text,
            attachments,
            markdown,
            presentationMode,
            automaticTitle,
            responseMode,
            undefined,
            false,
            admissionId,
            internal,
          );
        }, shared.queueEdits.withPermit);

        return {
          submit: (input) =>
            deliverInput(
              input.delivery,
              input.text,
              input.attachments,
              input.markdown,
              input.presentationMode,
              input.automaticTitle,
              input.responseMode,
              input.turnId,
              input.internal,
            ),
          recover: (inputs, paused = false) =>
            recoverInputs(inputs, paused).pipe(shared.queueEdits.withPermit),
          currentTurnIds: () =>
            Ref.get(shared.activeTurns).pipe(Effect.map((turns) => [...turns.keys()])),
          profile: shared.profile,
          updates,
          snapshot,
          inputReceipt: (turnId) =>
            Effect.gen(function* () {
              const record = yield* recoveryStorage
                .get(shared.runtime.sessionId)
                .pipe(sessionError("inputReceipt"));
              if (record?.canceledInputIds?.includes(turnId)) return "canceled" as const;
              if (shared.runtime.hasConsumedInput?.(turnId)) return "consumed" as const;
              if (record?.inputs.some((item) => item.turnId === turnId)) return "pending" as const;
              return undefined;
            }),
          admittedDigestIds:
            shared.profile === "CakeChatSession" || shared.profile === "ProjectSession"
              ? () =>
                  recoveryStorage.get(shared.runtime.sessionId).pipe(
                    Effect.map((record) => record?.deliveredDigestIds ?? []),
                    sessionError("digestReceipts"),
                  )
              : undefined,
          prompt: (
            text,
            attachments = [],
            markdown = false,
            presentationMode,
            automaticTitle,
            responseMode,
          ) =>
            deliverInput(
              "prompt",
              text,
              attachments,
              markdown,
              presentationMode,
              automaticTitle,
              responseMode,
            ),
          steer: (text, attachments = [], markdown = false, presentationMode, responseMode) =>
            deliverInput(
              "steer",
              text,
              attachments,
              markdown,
              presentationMode,
              undefined,
              responseMode,
            ),
          followUp: (text, attachments = [], markdown = false, presentationMode, responseMode) =>
            deliverInput(
              "follow-up",
              text,
              attachments,
              markdown,
              presentationMode,
              undefined,
              responseMode,
            ),
          queueCommand: Effect.fn("CakeSessionRuntimes.queueCommand")(function* (command) {
            // Like accepted prompts, commands retain their runtime until completion or cancellation.
            const commandScope = yield* Scope.make();
            const completed = yield* Deferred.make<void>();
            const receipt = yield* RcMap.get(runtimes, key).pipe(
              Effect.provideService(Scope.Scope, commandScope),
              Effect.flatMap((retained) =>
                runtimeOperation("queueCommand", () =>
                  retained.runtime.queueCommand(command, () => {
                    Deferred.doneUnsafe(completed, Effect.void);
                  }),
                ).pipe(shared.queueEdits.withPermit),
              ),
              sessionError("queueCommand"),
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Scope.close(commandScope, Exit.void) : Effect.void,
              ),
            );
            yield* Deferred.await(completed).pipe(
              Effect.ensuring(Scope.close(commandScope, Exit.void)),
              Effect.forkIn(layerScope),
            );
            return receipt;
          }),
          inspectSession: (query) =>
            call("inspectSession", (runtime) => runtime.inspectSession(query)),
          history: (cursor) =>
            call("history", (runtime) => {
              if (!runtime.history) throw new Error("This conversation does not paginate history");
              return runtime.history(cursor);
            }),
          listQueuedMessages: () =>
            call("listQueuedMessages", (runtime) => runtime.listQueuedMessages()),
          pendingMessages: () => call("pendingMessages", (runtime) => runtime.pendingMessages()),
          reorderPendingMessage: (input) =>
            editQueue("reorderPendingMessage", (runtime) => runtime.reorderPendingMessage(input)),
          clearQueue: () => editQueue("clearQueue", (runtime) => runtime.clearQueue()),
          cancelSteering: () => editQueue("cancelSteering", (runtime) => runtime.cancelSteering()),
          removeQueuedMessage: (partId) =>
            editQueue("removeQueuedMessage", (runtime) => runtime.removeQueuedMessage(partId)),
          steerQueuedMessage: (partId) =>
            editQueue("steerQueuedMessage", (runtime) => runtime.steerQueuedMessage(partId)),
          sendQueuedMessageNow: (partId) =>
            Effect.gen(function* () {
              // Pi validates the selection before aborting. Leave completion ownership
              // intact on rejection (and let prompt settlement clean up post-abort failures).
              const result = yield* call("sendQueuedMessageNow", (runtime) =>
                runtime.sendQueuedMessageNow(partId),
              );
              const claimed = yield* claimAbortedTurns(result.abortedTurnIds);
              yield* settleAbortedTurns(claimed, undefined);
              return result.queued;
            }),
          editMessage: (
            entryId,
            text,
            attachments,
            renderUserMessageAsMarkdown,
            presentationMode,
            responseMode,
          ) =>
            shared.runtime.editMessage
              ? call(
                  "editMessage",
                  (runtime) =>
                    runtime.editMessage?.(
                      entryId,
                      text,
                      [...attachments],
                      renderUserMessageAsMarkdown,
                      presentationMode,
                      responseMode,
                    ) ?? Promise.resolve(),
                )
              : Effect.fail(
                  new PiSessionError({
                    operation: "editMessage",
                    message: "Message editing is unavailable",
                  }),
                ),
          setUserMessageMarkdown: (entryId, renderAsMarkdown) =>
            call("setUserMessageMarkdown", (runtime) =>
              runtime.setUserMessageMarkdown(entryId, renderAsMarkdown),
            ),
          abort: Effect.fn("CakeSessionRuntimes.abort")(function* (stop?: TurnStop) {
            yield* recoveryGate
              .withPermit(
                Effect.gen(function* () {
                  const record = yield* recoveryStorage.get(shared.runtime.sessionId);
                  if (record) yield* recoveryStorage.update({ ...record, state: "stopped" });
                }),
              )
              .pipe(sessionError("abort"));
            const claimed = yield* claimAbortedTurns(shared.runtime.executingTurnIds?.() ?? []);
            yield* settleAbortedTurns(claimed, stop);
            yield* call("abort", (runtime) => runtime.abort(stop));
          }),
          executeCommand: (command, arguments_) =>
            command === "changelog"
              ? adapter.changelog().pipe(
                  sessionError("executeCommand"),
                  Effect.map((text) => text),
                )
              : call("executeCommand", (runtime) =>
                  runtime
                    .prompt(
                      `/${command}${arguments_.trim() ? ` ${arguments_.trim()}` : ""}`,
                      "prompt",
                      [],
                    )
                    .then(() => undefined),
                ),
          applyConfiguration: (configuration) =>
            call("applyConfiguration", (runtime) => runtime.applyConfiguration(configuration)),
          setModel: (provider, modelId) =>
            call("setModel", (runtime) => runtime.setModel(provider, modelId)),
          setFastMode: (enabled) =>
            shared.runtime.setFastMode
              ? call(
                  "setFastMode",
                  (runtime) => runtime.setFastMode?.(enabled) ?? Promise.resolve(),
                )
              : Effect.fail(
                  new PiSessionError({
                    operation: "setFastMode",
                    message: "Fast mode is unavailable",
                  }),
                ),
          setThinkingLevel: (level) =>
            call("setThinkingLevel", (runtime) => runtime.setThinkingLevel(level)),
          setPiSetting: (update) => call("setPiSetting", (runtime) => runtime.setPiSetting(update)),
          navigate: (entryId, options) =>
            call("navigate", (runtime) => runtime.navigate(entryId, options)),
          compact: (instructions) => call("compact", (runtime) => runtime.compact(instructions)),
          compactMemory: Effect.fn("CakeSessionRuntimes.compactMemory")(function* () {
            if ((yield* Ref.get(shared.activeTurns)).size > 0)
              return yield* new PiSessionError({
                operation: "compactMemory",
                message: "Wait for this chat to finish before compacting.",
              });
            yield* call("compactMemory", (runtime) => {
              if (!runtime.compactMemory)
                throw new Error("Memory compaction is only available for permanent chats.");
              return runtime.compactMemory();
            });
          }),
          compactIfIdle: Effect.fn("CakeSessionRuntimes.compactIfIdle")(function* (instructions) {
            // Accepted work can precede the runtime's asynchronous preparation.
            if ((yield* Ref.get(shared.activeTurns)).size > 0) return { status: "busy" as const };
            return yield* call("compactIfIdle", (runtime) => {
              if (!runtime.compactIfIdle)
                throw new Error("Idle-only compaction is unavailable for this runtime");
              return runtime.compactIfIdle(instructions);
            }).pipe(Effect.uninterruptible);
          }),
          rename: (name, onlyIfUnnamed) =>
            call("rename", (runtime) => runtime.rename(name, onlyIfUnnamed)),
          fork: (entryId, title) => call("fork", (runtime) => runtime.fork(entryId, title)),
          toolCompact: (entryId) => call("toolCompact", (runtime) => runtime.toolCompact(entryId)),
          reviewParentContext: () =>
            Effect.try({
              try: () => shared.runtime.getReviewParentContext?.(),
              catch: (cause) => cause,
            }).pipe(
              sessionError("reviewParentContext"),
              Effect.flatMap((context) =>
                context
                  ? Effect.succeed(context)
                  : Effect.fail(
                      new PiSessionError({
                        operation: "reviewParentContext",
                        message: "The parent session context is unavailable",
                      }),
                    ),
              ),
            ),
          // A worker report joins the parent's one input queue exactly like a user message:
          // visible, steerable, removable, and kept when other queued items are edited.
          notifySubagentCompletion: (result, completionId) => {
            const json = Schema.decodeUnknownSync(jsonValueSchema)(result);
            if (shared.runtime.notifySubagentCompletion)
              return call(
                "notifySubagentCompletion",
                (runtime) =>
                  runtime.notifySubagentCompletion?.(json, completionId) ?? Promise.resolve(),
              );
            const input = subagentCompletionInput(json, completionId);
            return deliverInput(
              "follow-up",
              input.text,
              [],
              false,
              undefined,
              false,
              undefined,
              completionId,
              input.internal,
            ).pipe(Effect.asVoid);
          },
          reload: () =>
            shared.runtime.reload
              ? call("reload", (runtime) => runtime.reload?.() ?? Promise.resolve())
              : Effect.fail(
                  new PiSessionError({ operation: "reload", message: "Reload is unavailable" }),
                ),
          publishSessionChanged: () =>
            (key.options.onSessionChanged ?? Effect.void).pipe(
              sessionError("publishSessionChanged"),
            ),
          callCakeOperation: (command, input) =>
            shared.runtime.callCakeOperation
              ? cancellableRuntimeOperation(
                  "callCakeOperation",
                  (signal) =>
                    shared.runtime.callCakeOperation?.(command, input, signal) ??
                    Promise.reject(new Error("Cake operations are unavailable")),
                )
              : Effect.fail(
                  new PiSessionError({
                    operation: "callCakeOperation",
                    message: "Cake operations are unavailable",
                  }),
                ),
          dispatchExtensionCompanionAction: (id, action, value) =>
            shared.runtime.dispatchExtensionCompanionAction
              ? call(
                  "dispatchExtensionCompanionAction",
                  (runtime) =>
                    runtime.dispatchExtensionCompanionAction?.(id, action, value) ??
                    Promise.resolve(),
                )
              : Effect.fail(
                  new PiSessionError({
                    operation: "dispatchExtensionCompanionAction",
                    message: "Extension companions are unavailable",
                  }),
                ),
        } satisfies CakeSessionHandle;
      });

      const currentTurnIds = Effect.fn("CakeSessionRuntimes.currentTurnIds")(function* (
        target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
      ) {
        const shared = [...activeRuntimes].find(
          (candidate) =>
            candidate.workingDirectory === target.workingDirectory &&
            candidate.sessionDirectory === target.sessionDirectory &&
            candidate.runtime.sessionId === target.sessionId,
        );
        return shared ? [...(yield* Ref.get(shared.activeTurns)).keys()] : [];
      });

      const executingTurnIds = Effect.fn("CakeSessionRuntimes.executingTurnIds")(function* (
        target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
      ) {
        const shared = [...activeRuntimes].find(
          (candidate) =>
            candidate.workingDirectory === target.workingDirectory &&
            candidate.sessionDirectory === target.sessionDirectory &&
            candidate.runtime.sessionId === target.sessionId,
        );
        return yield* Effect.sync(() => shared?.runtime.executingTurnIds?.() ?? []);
      });

      const refreshModels = Effect.fn("CakeSessionRuntimes.refreshModels")(function* () {
        yield* Effect.forEach(
          activeRuntimes,
          (shared) => {
            const refresh = shared.runtime.refreshModels;
            return refresh
              ? runtimeOperation("refreshModels", () => refresh.call(shared.runtime))
              : Effect.void;
          },
          { concurrency: "unbounded", discard: true },
        );
      });
      const reloadShared = Effect.fn("CakeSessionRuntimes.reloadShared")(function* (
        operation: string,
        selected: ReadonlyArray<SharedRuntime>,
      ) {
        yield* Effect.forEach(
          selected,
          (shared) => {
            const reload = shared.runtime.reload;
            return reload
              ? runtimeOperation(operation, () => reload.call(shared.runtime))
              : Effect.void;
          },
          { concurrency: "unbounded", discard: true },
        );
      });
      const reloadWorkingDirectory = Effect.fn("CakeSessionRuntimes.reloadWorkingDirectory")(
        function* (workingDirectory: string) {
          yield* reloadShared(
            "reloadWorkingDirectory",
            [...activeRuntimes].filter((shared) => shared.workingDirectory === workingDirectory),
          );
        },
      );
      const reloadAll = Effect.fn("CakeSessionRuntimes.reloadAll")(function* () {
        yield* reloadShared("reloadAll", [...activeRuntimes]);
      });
      const reloadCakeChatContext = Effect.fn("CakeSessionRuntimes.reloadCakeChatContext")(
        function* () {
          yield* reloadShared(
            "reloadCakeChatContext",
            [...activeRuntimes].filter((shared) => shared.profile === "CakeChatSession"),
          );
        },
      );
      const durableArtifactReferences = Effect.fn("CakeSessionRuntimes.durableArtifactReferences")(
        function* (sessionRoots: ReadonlyArray<string>) {
          if (!adapter.durableArtifactReferences)
            return yield* new PiSessionError({
              operation: "durableArtifactReferences",
              message: "Durable artifact pointer enumeration is unavailable",
            });
          return yield* adapter
            .durableArtifactReferences(sessionRoots)
            .pipe(sessionError("durableArtifactReferences"));
        },
      );

      const acquireCurrent = Effect.fn("CakeSessionRuntimes.acquireCurrent")(function* (
        target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
      ) {
        const key = `${target.workingDirectory}\u0000${target.sessionDirectory}\u0000${target.sessionId}`;
        const options = acquiredOptions.get(key);
        if (!options)
          return yield* new PiSessionError({
            operation: "acquireCurrent",
            message: `Pi Session ${target.sessionId} is not currently acquired`,
          });
        return yield* acquire(options);
      });

      const acquireSession = Effect.fn("CakeSessionRuntimes.acquireSession")(function* (
        sessionId: string,
      ) {
        const matches = [...acquiredOptions.values()].filter(
          (options) => options.runtime.sessionId === sessionId,
        );
        const options = matches[0];
        if (!options)
          return yield* new PiSessionError({
            operation: "acquireSession",
            message: `Pi Session ${sessionId} has not been assembled`,
          });
        if (matches.some((candidate) => runtimeTarget(candidate) !== runtimeTarget(options)))
          return yield* new PiSessionError({
            operation: "acquireSession",
            message: `Pi Session ID collision detected: ${sessionId}`,
          });
        return yield* acquire(options);
      });

      const hasCurrent = Effect.fn("CakeSessionRuntimes.hasCurrent")(
        (target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">) =>
          Effect.sync(() =>
            [...activeRuntimes].some(
              (candidate) =>
                candidate.workingDirectory === target.workingDirectory &&
                candidate.sessionDirectory === target.sessionDirectory &&
                candidate.runtime.sessionId === target.sessionId,
            ),
          ),
      );

      const currentStatus = Effect.fn("CakeSessionRuntimes.currentStatus")(function* (
        target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
      ) {
        const shared = [...activeRuntimes].find(
          (candidate) =>
            candidate.workingDirectory === target.workingDirectory &&
            candidate.sessionDirectory === target.sessionDirectory &&
            candidate.runtime.sessionId === target.sessionId,
        );
        const recovered = yield* recoveryStorage.get(target.sessionId).pipe(Effect.result);
        const recovery = recovered._tag === "Success" ? recovered.success : undefined;
        const recoveryIssue =
          recovered._tag === "Failure"
            ? recovered.failure.message
            : recovery?.state === "blocked"
              ? (recovery.issue ?? "Cannot resume this session")
              : undefined;
        const latestTurnOutcome =
          recovery?.state === "complete" || recovery?.state === "failed"
            ? recovery.state
            : recovery?.state === "stopped"
              ? ("aborted" as const)
              : undefined;
        if (!shared)
          return recovery || recoveryIssue
            ? {
                streaming: false,
                pending: (recovery?.inputs.length ?? 0) > 0,
                persisted: true,
                recoveryIssue,
                latestTurnOutcome,
              }
            : undefined;
        const queued = yield* runtimeOperation("currentStatus", () =>
          shared.runtime.listQueuedMessages(),
        ).pipe(Effect.orDie);
        // Accepted prompts bridge preparation to Pi's first event. Queued
        // follow-ups and correlations retained after Pi stops are not work.
        const streaming =
          shared.runtime.streaming ||
          [...(yield* Ref.get(shared.activeTurns))].some(
            ([id, delivery]) => delivery !== "follow-up" && !shared.settledInputIds.has(id),
          );
        return {
          recoveryIssue,
          latestTurnOutcome,
          streaming,
          ...(streaming && shared.activityTiming.startedAt !== undefined
            ? { workingStartedAt: shared.activityTiming.startedAt }
            : null),
          pending: queued.steering.length > 0 || queued.followUp.length > 0,
          persisted: shared.runtime.sessionFile.length > 0,
        };
      });

      const currentModifiedAt = Effect.fn("CakeSessionRuntimes.currentModifiedAt")(function* (
        target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
      ) {
        const sessionFile = [...activeRuntimes].find(
          (candidate) =>
            candidate.workingDirectory === target.workingDirectory &&
            candidate.sessionDirectory === target.sessionDirectory &&
            candidate.runtime.sessionId === target.sessionId,
        )?.runtime.sessionFile;
        if (!sessionFile) return undefined;
        // An unwritten or relocated transcript simply has no newer activity time.
        return yield* Effect.promise(() =>
          stat(sessionFile).then(
            (stats) => stats.mtime.toISOString(),
            () => undefined,
          ),
        );
      });

      return CakeSessionRuntimes.of({
        forgetRecovery: (sessionId) =>
          recoveryGate
            .withPermit(recoveryStorage.remove(sessionId))
            .pipe(sessionError("forgetRecovery")),
        sessionIds,
        catalog,
        catalogEntry,
        inspect,
        acquire,
        acquireCurrent,
        acquireSession,
        hasCurrent,
        currentStatus,
        currentModifiedAt,
        currentTurnIds,
        executingTurnIds,
        refreshModels,
        reloadWorkingDirectory,
        reloadAll,
        reloadCakeChatContext,
        durableArtifactReferences,
      });
    }),
  );

export const makeCakeSessionRuntimesLive = (
  createRuntime: (options: CakeSessionRuntimeSetup) => Promise<CakeSessionRuntime>,
): Layer.Layer<CakeSessionRuntimes, never, CakeChatDurable | RuntimeRecoveryStorage> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const durable = yield* CakeChatDurable;
      const coordinatorCatalog = durable.catalogEntry;
      return makeCakeSessionRuntimesLayer({
        sessionIds: (query) =>
          query.cakeChatSessionId
            ? Stream.fromEffect(
                coordinatorCatalog(query.sessionDirectory, query.cakeChatSessionId),
              ).pipe(
                Stream.filter((item) => item !== undefined),
                Stream.map((item) => item.id),
              )
            : streamWorkspaceSessionIds(query.workingDirectory, query.sessionDirectory, {
                direct: query.direct,
                excludedSessionIds: query.excludedSessionIds,
              }),
        catalog: (query) =>
          query.cakeChatSessionId
            ? Stream.fromEffect(
                coordinatorCatalog(query.sessionDirectory, query.cakeChatSessionId),
              ).pipe(Stream.filter((item) => item !== undefined))
            : streamWorkspaceSessions(query.workingDirectory, query.sessionDirectory, {
                direct: query.direct,
                excludedSessionIds: query.excludedSessionIds,
              }),
        catalogEntry: (query, sessionId) =>
          query.cakeChatSessionId
            ? coordinatorCatalog(query.sessionDirectory, query.cakeChatSessionId).pipe(
                Effect.map((item) => (item?.id === sessionId ? item : undefined)),
              )
            : Effect.tryPromise({
                try: () =>
                  loadWorkspacePiSessionSummary(
                    query.workingDirectory,
                    sessionId,
                    query.sessionDirectory,
                    {
                      direct: query.direct,
                    },
                  ),
                catch: (cause) => cause,
              }),
        inspect: (target, options) =>
          target.cakeChatSessionId
            ? durable.inspect(target.sessionDirectory, target.sessionId)
            : cakeChatSideChatConversationId(target.sessionId) !== undefined
              ? durable.inspectSideChat(target.sessionId)
              : Effect.tryPromise({
                  try: () =>
                    loadWorkspacePiSessionPreview(
                      target.workingDirectory,
                      target.sessionId,
                      target.sessionDirectory,
                      target.direct,
                      options,
                    ),
                  catch: (cause) => cause,
                }),
        createRuntime: (options) =>
          options.globalControl
            ? durable.createRuntime(options)
            : cakeChatSideChatConversationId(options.sessionId) !== undefined
              ? durable.createSideChatRuntime(options)
              : Effect.tryPromise({
                  try: () => createRuntime(options),
                  catch: (cause) => cause,
                }),
        changelog: () => Effect.sync(loadPiChangelog),
        durableArtifactReferences: (sessionRoots) =>
          Effect.tryPromise({
            try: () => loadDurableArtifactReferences(sessionRoots),
            catch: (cause) => cause,
          }),
      });
    }),
  );
