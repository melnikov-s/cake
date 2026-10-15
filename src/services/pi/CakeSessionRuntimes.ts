import { stat } from "node:fs/promises";
import type { CakeOperationOptions } from "../../contracts/agent/cake-operation-options";
import {
  Context,
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
import { CakeChatDurable } from "../pi-durable/CakeChatDurable";
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
});
export interface PiSessionQuery extends Schema.Schema.Type<typeof PiSessionQuery> {}

export const PiSessionTarget = Schema.Struct({
  workingDirectory: Schema.String,
  sessionId: Schema.String,
  sessionDirectory: Schema.String,
  resolvedSessionDirectory: Schema.optionalKey(Schema.String),
  direct: Schema.optionalKey(Schema.Boolean),
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
    accept: Effect.Effect<void>,
  ) => Effect.Effect<void, unknown>;
  readonly onTurnSettled?: (event: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly outcome: "complete" | "failed" | "aborted";
    readonly result?: PiTurnResult;
    readonly message?: string;
  }) => Effect.Effect<void, unknown>;
  /** Publishes lightweight activity after accepted turns start or settle. */
  readonly onTurnActivityChanged?: Effect.Effect<void>;
  /** Publishes kind-specific catalog metadata after shared conversation mutations. */
  readonly onSessionChanged?: Effect.Effect<void, unknown>;
}

export interface CakeSessionHandle {
  readonly currentTurnIds: () => Effect.Effect<ReadonlyArray<string>>;
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
  readonly abort: () => Effect.Effect<void, PiSessionError>;
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
    readonly inspect: (target: PiSessionTarget) => Effect.Effect<PiSessionPreview, PiSessionError>;
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
  readonly settledInputIds: Set<string>;
  readonly turnResults: Map<string, PiTurnResult>;
  readonly queueEdits: Semaphore.Semaphore;
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
  if (
    valid &&
    (!runtime.projectInvestigation || (profile === "SubagentSession" && runtime.ephemeral === true))
  )
    return;
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
                  if (event.type === "streaming" && !event.streaming)
                    for (const id of currentRuntime?.executingTurnIds?.() ?? [])
                      settledInputIds.add(id);
                  const projected: PiSessionEvent =
                    event.type === "snapshot"
                      ? { type: "snapshot-updated", snapshot: event.snapshot }
                      : event;
                  PubSub.publishUnsafe(events, projected);
                },
              });
              currentRuntime = runtime;
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
                queueEdits: Semaphore.makeUnsafe(1),
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

      const inspect = Effect.fn("CakeSessionRuntimes.inspect")(function* (target: PiSessionTarget) {
        const decoded = yield* Schema.decodeUnknownEffect(PiSessionTarget)(target).pipe(
          sessionError("inspect"),
        );
        const preview = yield* adapter.inspect(decoded).pipe(sessionError("inspect"));
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
        // Whole-queue replacements from every acquired handle share one runtime gate.
        // Never hold this gate for an executing prompt or send-now's new turn.
        const editQueue = <A>(
          operation: string,
          evaluate: (runtime: CakeSessionRuntime) => Promise<A>,
        ) => call(operation, evaluate).pipe(shared.queueEdits.withPermit);
        const updates = Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading the snapshot. Runtime events produced
            // while Pi builds the snapshot are buffered by this subscription,
            // eliminating the initial snapshot/live-event gap.
            const subscription = yield* PubSub.subscribe(shared.events);
            const snapshot = yield* call("observe", (runtime) => runtime.snapshot());
            return Stream.make({ _tag: "Snapshot" as const, snapshot }).pipe(
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
        ) {
          const turnId = crypto.randomUUID();
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
            retained.settledInputIds.delete(turnId);
            const result = retained.turnResults.get(turnId);
            retained.turnResults.delete(turnId);
            const settledOutcome =
              outcome !== "complete"
                ? outcome
                : result?.stopReason === "error"
                  ? "failed"
                  : result?.stopReason === "aborted"
                    ? "aborted"
                    : outcome;
            if (active) {
              const event: PiSessionEvent = {
                type: "turn-settled",
                sessionId: retained.runtime.sessionId,
                turnId,
                outcome: settledOutcome,
              };
              if (message !== undefined) Object.assign(event, { message });
              yield* PubSub.publish(retained.events, event);
              yield* key.options.onTurnActivityChanged ?? Effect.void;
              if (key.options.onTurnSettled)
                yield* key.options.onTurnSettled({
                  sessionId: retained.runtime.sessionId,
                  turnId,
                  outcome: settledOutcome,
                  ...(result ? { result } : null),
                  ...(message ? { message } : null),
                });
            }
          });
          const finished = yield* Deferred.make<void, PiSessionError>();
          // Input the user withdrew (abort, removed queue row, cleared queue) is a
          // cancellation of accepted work, not a failure of the session.
          const run = Effect.tryPromise({
            try: () =>
              retained.runtime.prompt(
                text,
                delivery,
                [...attachments],
                markdown,
                turnId,
                presentationMode,
                automaticTitle,
                responseMode,
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
          return turnId;
        });

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
        ) {
          yield* Effect.forEach(
            turnIds,
            (turnId) =>
              Effect.gen(function* () {
                shared.settledInputIds.delete(turnId);
                shared.turnResults.delete(turnId);
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

        return {
          currentTurnIds: () =>
            Ref.get(shared.activeTurns).pipe(Effect.map((turns) => [...turns.keys()])),
          profile: shared.profile,
          updates,
          snapshot: () => call("snapshot", (runtime) => runtime.snapshot()),
          prompt: (
            text,
            attachments = [],
            markdown = false,
            presentationMode,
            automaticTitle,
            responseMode,
          ) =>
            startTurn(
              "prompt",
              text,
              attachments,
              markdown,
              presentationMode,
              automaticTitle,
              responseMode,
            ),
          steer: (text, attachments = [], markdown = false, presentationMode, responseMode) =>
            startTurn(
              "steer",
              text,
              attachments,
              markdown,
              presentationMode,
              undefined,
              responseMode,
            ),
          followUp: (text, attachments = [], markdown = false, presentationMode, responseMode) =>
            startTurn(
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
              const claimed = yield* claimAbortedTurns(shared.runtime.executingTurnIds?.() ?? []);
              const result = yield* call("sendQueuedMessageNow", (runtime) =>
                runtime.sendQueuedMessageNow(partId),
              );
              yield* settleAbortedTurns(claimed);
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
          abort: Effect.fn("CakeSessionRuntimes.abort")(function* () {
            const claimed = yield* claimAbortedTurns(shared.runtime.executingTurnIds?.() ?? []);
            yield* call("abort", (runtime) => runtime.abort());
            yield* settleAbortedTurns(claimed);
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
          notifySubagentCompletion: (result) =>
            shared.runtime.notifySubagentCompletion
              ? call(
                  "notifySubagentCompletion",
                  (runtime) =>
                    runtime.notifySubagentCompletion?.(
                      Schema.decodeUnknownSync(jsonValueSchema)(result),
                    ) ?? Promise.resolve(),
                )
              : Effect.fail(
                  new PiSessionError({
                    operation: "notifySubagentCompletion",
                    message: "Subagent completion delivery is unavailable",
                  }),
                ),
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

      const currentStatus = Effect.fn("CakeSessionRuntimes.currentStatus")(function* (
        target: Pick<PiSessionTarget, "workingDirectory" | "sessionId" | "sessionDirectory">,
      ) {
        const shared = [...activeRuntimes].find(
          (candidate) =>
            candidate.workingDirectory === target.workingDirectory &&
            candidate.sessionDirectory === target.sessionDirectory &&
            candidate.runtime.sessionId === target.sessionId,
        );
        if (!shared) return undefined;
        const queued = yield* runtimeOperation("currentStatus", () =>
          shared.runtime.listQueuedMessages(),
        ).pipe(Effect.orDie);
        return {
          streaming:
            shared.runtime.streaming ||
            // Accepted prompts bridge preparation to Pi's first event. Queued
            // follow-ups and correlations retained after Pi stops are not work.
            [...(yield* Ref.get(shared.activeTurns))].some(
              ([id, delivery]) => delivery !== "follow-up" && !shared.settledInputIds.has(id),
            ),
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
        sessionIds,
        catalog,
        catalogEntry,
        inspect,
        acquire,
        acquireCurrent,
        acquireSession,
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

const coordinatorDirectory = (directory: string) => /(?:^|[/\\])global-chat$/.test(directory);

export const makeCakeSessionRuntimesLive = (
  createRuntime: (options: CakeSessionRuntimeSetup) => Promise<CakeSessionRuntime>,
): Layer.Layer<CakeSessionRuntimes, never, CakeChatDurable> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const durable = yield* CakeChatDurable;
      const coordinatorCatalog = durable.catalogEntry;
      return makeCakeSessionRuntimesLayer({
        sessionIds: (query) =>
          coordinatorDirectory(query.sessionDirectory)
            ? Stream.fromEffect(coordinatorCatalog(query.sessionDirectory)).pipe(
                Stream.filter((item) => item !== undefined),
                Stream.map((item) => item.id),
              )
            : streamWorkspaceSessionIds(query.workingDirectory, query.sessionDirectory, {
                direct: query.direct,
                excludedSessionIds: query.excludedSessionIds,
              }),
        catalog: (query) =>
          coordinatorDirectory(query.sessionDirectory)
            ? Stream.fromEffect(coordinatorCatalog(query.sessionDirectory)).pipe(
                Stream.filter((item) => item !== undefined),
              )
            : streamWorkspaceSessions(query.workingDirectory, query.sessionDirectory, {
                direct: query.direct,
                excludedSessionIds: query.excludedSessionIds,
              }),
        catalogEntry: (query, sessionId) =>
          coordinatorDirectory(query.sessionDirectory)
            ? coordinatorCatalog(query.sessionDirectory).pipe(
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
        inspect: (target) =>
          coordinatorDirectory(target.sessionDirectory)
            ? durable.inspect(target.sessionDirectory, target.sessionId)
            : Effect.tryPromise({
                try: () =>
                  loadWorkspacePiSessionPreview(
                    target.workingDirectory,
                    target.sessionId,
                    target.sessionDirectory,
                    target.direct,
                  ),
                catch: (cause) => cause,
              }),
        createRuntime: (options) =>
          options.globalControl
            ? durable.createRuntime(options)
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
