import type { TurnStop } from "../../contracts/conversations/turn-stop";
import type { InternalInput } from "../../contracts/conversations/internal-input";
import type { IdleCompactionResult } from "../../contracts/project-sessions/session-compaction";
import { sessionDigestReceiptIds } from "../../contracts/cake-chats/session-digest-reminder";
import {
  RuntimeRecoveryStorage,
  type RuntimeRecoveryInput,
} from "../storage/RuntimeRecoveryStorage";
import { stat } from "node:fs/promises";
import {
  hasSessionFileById,
  snapshotSessionFiles,
  type SessionFileSnapshot,
} from "../storage/session-files";
import type { CakeOperationOptions } from "../../contracts/agent/cake-operation-options";
import type { CakeOperationInvocation } from "../../contracts/agent/cake-operation";
import type { Scope } from "effect";
import { Context, Clock, Effect, Layer, Ref, Schema, Semaphore, Stream } from "effect";
import type {
  PiPendingMessageReorder,
  PiPendingMessages,
  PiQueuedMessages,
} from "../../contracts/conversations/pending-message-data";
import type { ArtifactPointer } from "../../contracts/artifacts/artifact-contract";
import type { JsonObject, JsonValue } from "../../contracts/serialization/json-contract";
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
import { cakeChatSideChatConversationId } from "../../contracts/cake-chats/cake-chat-identity";
import { createSessionRuntimeHandle } from "./session-runtime-handle";
import {
  makeSessionRuntimeRegistry,
  runtimeTarget,
  type SharedRuntime,
  type PiSessionCapabilityProfile,
} from "./session-runtime-registry";
import {
  messageOf,
  sessionError,
  sessionErrorValue,
  runtimeOperation,
} from "./session-runtime-operations";
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
import type { ScheduledInputReceipt } from "../../contracts/scheduled-messages/scheduled-input-receipt";

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
  reason: Schema.optionalKey(Schema.Literal("side-chat-busy")),
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
  /** Activates this candidate only when constructing the shared runtime, never on a cache hit. */
  readonly onInitialize?: Effect.Effect<void, unknown>;
  /** Finalizes this candidate on construction failure or after the final shared runtime lease. */
  readonly onRelease?: Effect.Effect<void, unknown>;
  readonly admitTurn?: (
    input: {
      readonly turnId: string;
      readonly text: string;
      readonly delivery: "prompt" | "steer" | "follow-up";
      readonly internal?: InternalInput;
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
  /** New regular session's first durable conversation message, never a renderer selection. */
  readonly onSessionCreated?: Effect.Effect<void, unknown>;
}

import type { SideChatHistory, SideChatHistoryImport } from "./side-chat-history";

export interface CakeSessionHandle {
  readonly exportSideChatHistory: () => Effect.Effect<SideChatHistory, PiSessionError>;
  readonly importSideChatHistory: (
    input: SideChatHistoryImport,
  ) => Effect.Effect<{ importedMessages: number }, PiSessionError>;
  readonly currentTurnIds: () => Effect.Effect<ReadonlyArray<string>>;
  readonly recover: (
    inputs: ReadonlyArray<RuntimeRecoveryInput>,
    paused?: boolean,
  ) => Effect.Effect<void, PiSessionError>;
  /** Admit a new input with its owner's durable ID; unlike recover, this is explicit continuation. */
  readonly submit: (input: RuntimeRecoveryInput) => Effect.Effect<string, PiSessionError>;
  /** Permanent-chat receipt metadata; other profiles do not expose a digest inbox. */
  readonly admittedDigestIds?: () => Effect.Effect<ReadonlyArray<string>, PiSessionError>;
  readonly cancelScheduledInput?: (turnId: string) => Effect.Effect<void, PiSessionError>;
  readonly scheduledInputReceipt?: (
    turnId: string,
  ) => Effect.Effect<ScheduledInputReceipt | undefined, PiSessionError>;
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
  readonly updateQueuedMessage: (
    partId: string,
    text: string,
  ) => Effect.Effect<PiQueuedMessages, PiSessionError>;
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
  readonly toolPruneIfIdle: () => Effect.Effect<IdleCompactionResult, PiSessionError>;
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
  readonly toolPrune: (
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
  readonly callCakeTool: (
    command: string,
    input: JsonObject,
  ) => Effect.Effect<CakeOperationInvocation, PiSessionError>;
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
    fileSnapshot?: SessionFileSnapshot,
  ) => Effect.Effect<PiSessionSummary | undefined, unknown>;
  readonly inspect: (
    target: PiSessionTarget,
    options?: { readonly includeParts?: boolean; readonly sessionFile?: string },
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
    /** Regular-Pi discovery evidence owned by one catalog generation, never recovery authority. */
    readonly catalogSnapshot: (
      query: PiSessionQuery,
    ) => Effect.Effect<SessionFileSnapshot, PiSessionError>;
    readonly catalogEntry: (
      query: PiSessionQuery,
      sessionId: string,
      fileSnapshot?: SessionFileSnapshot,
    ) => Effect.Effect<PiSessionSummary | undefined, PiSessionError>;
    /** Recovery authority only: exact filename/collision checks and shared-root cwd discovery,
     * without title/transcript projection. Permanent Cake Chat uses its Durable owner. */
    readonly hasTranscript: (
      target: Pick<
        PiSessionTarget,
        "workingDirectory" | "sessionDirectory" | "sessionId" | "direct"
      >,
    ) => Effect.Effect<boolean, PiSessionError>;
    readonly inspect: (
      target: PiSessionTarget,
      options?: { readonly includeParts?: boolean; readonly sessionFile?: string },
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
    /** Live activity only; does not read history/recovery or acquire runtimes. */
    readonly activeWorkingDirectories: () => Effect.Effect<ReadonlyArray<string>>;
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
      const registry = yield* makeSessionRuntimeRegistry({
        adapter,
        clock,
        recoveryStorage,
        recoveryGate,
        layerScope,
      });
      const { activeRuntimes } = registry;

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
        options?: { readonly includeParts?: boolean; readonly sessionFile?: string },
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

      const hasTranscript = Effect.fn("CakeSessionRuntimes.hasTranscript")(function* (
        target: Pick<
          PiSessionTarget,
          "workingDirectory" | "sessionDirectory" | "sessionId" | "direct"
        >,
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(PiSessionTarget)(target).pipe(
          sessionError("hasTranscript"),
        );
        return yield* Effect.tryPromise({
          try: () =>
            hasSessionFileById(decoded.sessionId, {
              workingDirectory: decoded.workingDirectory,
              root: decoded.sessionDirectory,
              direct: decoded.direct,
            }),
          catch: sessionErrorValue("hasTranscript"),
        });
      });

      const catalogSnapshot = Effect.fn("CakeSessionRuntimes.catalogSnapshot")(function* (
        query: PiSessionQuery,
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(PiSessionQuery)(query).pipe(
          sessionError("catalogSnapshot"),
        );
        if (decoded.cakeChatSessionId)
          return yield* new PiSessionError({
            operation: "catalogSnapshot",
            message: "Permanent Cake Chat does not use Pi session files",
          });
        return yield* Effect.tryPromise({
          try: (signal) =>
            snapshotSessionFiles(
              {
                workingDirectory: decoded.workingDirectory,
                root: decoded.sessionDirectory,
                direct: decoded.direct,
              },
              signal,
            ),
          catch: sessionErrorValue("catalogSnapshot"),
        });
      });

      const catalogEntry = Effect.fn("CakeSessionRuntimes.catalogEntry")(function* (
        query: PiSessionQuery,
        sessionId: string,
        fileSnapshot?: SessionFileSnapshot,
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(PiSessionQuery)(query).pipe(
          sessionError("catalogEntry"),
        );
        return yield* adapter
          .catalogEntry(decoded, sessionId, fileSnapshot)
          .pipe(sessionError("catalogEntry"));
      });

      const acquire = Effect.fn("CakeSessionRuntimes.acquire")(function* (
        requested: CakeSessionRuntimeAcquireOptions,
      ) {
        const { shared, options, retain } = yield* registry.acquire(requested);
        return createSessionRuntimeHandle({
          shared,
          options,
          retain,
          layerScope,
          clock,
          recoveryStorage,
          recoveryGate,
          persistInput,
          removeRecoveryInput,
          changelog: adapter.changelog,
        });
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
        const options = [...activeRuntimes].find(
          (shared) =>
            shared.workingDirectory === target.workingDirectory &&
            shared.sessionDirectory === target.sessionDirectory &&
            shared.runtime.sessionId === target.sessionId,
        )?.acquireOptions;
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
        const matches = [...activeRuntimes].filter(
          (shared) => shared.runtime.sessionId === sessionId,
        );
        const oldest = matches[0];
        if (!oldest)
          return yield* new PiSessionError({
            operation: "acquireSession",
            message: `Pi Session ${sessionId} has not been assembled`,
          });
        const locations = matches.map((shared) => ({
          cwd: shared.workingDirectory,
          sessionDir: shared.sessionDirectory,
        }));
        if (
          matches.some(
            (shared) =>
              runtimeTarget(shared.acquireOptions) !== runtimeTarget(oldest.acquireOptions),
          )
        ) {
          // A permanent chat must stay usable: its oldest runtime is the one every
          // later acquisition joins. Other profiles have no lasting lease to work around.
          if (oldest.profile !== "CakeChatSession") {
            yield* Effect.logError("Pi Session ID collision", { sessionId, locations });
            return yield* new PiSessionError({
              operation: "acquireSession",
              message: `Pi Session ID collision detected: ${sessionId}`,
            });
          }
          yield* Effect.logError(
            "Permanent chat has runtimes at several locations; using the oldest",
            {
              sessionId,
              locations,
            },
          );
        }
        return yield* acquire(oldest.acquireOptions);
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

      const activeWorkingDirectories = Effect.fn("CakeSessionRuntimes.activeWorkingDirectories")(
        function* () {
          const directories = new Set<string>();
          for (const shared of activeRuntimes) {
            if (
              shared.runtime.streaming ||
              [...(yield* Ref.get(shared.activeTurns))].some(
                ([id, delivery]) => delivery !== "follow-up" && !shared.settledInputIds.has(id),
              )
            )
              directories.add(shared.workingDirectory);
          }
          return [...directories];
        },
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
        catalogSnapshot,
        hasTranscript,
        inspect,
        acquire,
        acquireCurrent,
        acquireSession,
        hasCurrent,
        currentStatus,
        activeWorkingDirectories,
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
        catalogEntry: (query, sessionId, fileSnapshot) =>
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
                      fileSnapshot,
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
        // Side chats inherit coordinator controls without becoming the coordinator.
        // Their canonical conversation identity chooses the engine before capabilities.
        createRuntime: (options) =>
          cakeChatSideChatConversationId(options.sessionId) !== undefined
            ? durable.createSideChatRuntime(options)
            : options.globalControl
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
