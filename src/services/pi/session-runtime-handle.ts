import { stat } from "node:fs/promises";
import type { Clock, Semaphore } from "effect";
import {
  Deferred,
  Effect,
  Exit,
  PubSub,
  Ref,
  Schedule,
  Scope,
  Stream,
  Struct,
  Schema,
} from "effect";
import type { TurnStop } from "../../contracts/conversations/turn-stop";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { jsonValueSchema } from "../../contracts/serialization/json-contract";
import { subagentCompletionInput } from "../../contracts/subagents/subagent-report";
import type { Attachment } from "../../contracts/conversations/session-contract";
import type { ProjectSessionPresentationMode } from "../../contracts/project-sessions/project-session-presentation";
import type { ConversationResponseMode } from "../../contracts/conversations/response-mode-reminders";
import type {
  RuntimeRecoveryInput,
  RuntimeRecoveryStorage,
} from "../storage/RuntimeRecoveryStorage";
import {
  PiSessionError,
  type CakeSessionHandle,
  type CakeSessionRuntimeAcquireOptions,
  type CakeSessionRuntimesAdapter,
  type PiSessionEvent,
  type PiSessionUpdate,
} from "./CakeSessionRuntimes";
import type { CakeSessionRuntime } from "./runtime/cake-session-runtime";
import { TurnCanceledError, TurnDetachedError } from "./runtime/RuntimeTurnCompletion";
import type { SharedRuntime } from "./session-runtime-registry";
import {
  messageOf,
  sessionError,
  runtimeOperation,
  cancellableRuntimeOperation,
} from "./session-runtime-operations";

export function createSessionRuntimeHandle(input: {
  readonly shared: SharedRuntime;
  readonly options: CakeSessionRuntimeAcquireOptions;
  readonly retain: () => Effect.Effect<SharedRuntime, unknown, Scope.Scope>;
  readonly layerScope: Scope.Scope;
  readonly clock: Clock.Clock;
  readonly recoveryStorage: RuntimeRecoveryStorage["Service"];
  readonly recoveryGate: Semaphore.Semaphore;
  readonly persistInput: (
    shared: SharedRuntime,
    input: RuntimeRecoveryInput,
    paused?: boolean,
  ) => Effect.Effect<void, unknown>;
  readonly removeRecoveryInput: (
    sessionId: string,
    turnId: string,
    outcome: "complete" | "failed" | "aborted",
  ) => Effect.Effect<void, unknown>;
  readonly changelog: CakeSessionRuntimesAdapter["changelog"];
}): CakeSessionHandle {
  const {
    shared,
    options,
    retain,
    layerScope,
    clock,
    recoveryStorage,
    recoveryGate,
    persistInput,
    removeRecoveryInput,
    changelog,
  } = input;
  const call = <A>(operation: string, evaluate: (runtime: CakeSessionRuntime) => Promise<A>) =>
    runtimeOperation(operation, () => evaluate(shared.runtime));
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
                return input
                  ? [
                      {
                        ...input,
                        delivery: queued.delivery,
                        text: queued.text,
                        internal: queued.internal,
                      },
                    ]
                  : [];
              }),
            ];
            yield* recoveryStorage.update({
              ...record,
              inputs,
              state: inputs.length === 0 && record.state === "active" ? "complete" : record.state,
              canceledInputIds: [...new Set([...(record.canceledInputIds ?? []), ...cancelled])],
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
      recovered?.turnId ?? admissionId ?? coordination?.metadata.messageId ?? crypto.randomUUID();
    if ((yield* Ref.get(shared.activeTurns)).has(turnId) || shared.settledInputIds.has(turnId))
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
      // A stable admission id also belongs to human input carrying reminders.
      // Only automatic work must wait for a person to resume a stopped session.
      if (
        internal?._tag !== "UserWithReminders" &&
        (record?.state === "blocked" || (record?.state === "stopped" && record.inputs.length > 0))
      )
        return yield* new PiSessionError({
          operation: delivery,
          message: "This session needs user input before accepting more automatic work",
        });
    }
    const turnScope = yield* Scope.make();
    const retained = yield* retain().pipe(
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
        yield* options.onTurnActivityChanged ?? Effect.void;
        if (options.onTurnSettled)
          yield* options.onTurnSettled({
            sessionId: retained.runtime.sessionId,
            turnId,
            outcome: settledOutcome,
            ...(result ? { result } : null),
            ...(settledMessage ? { message: settledMessage } : null),
          });
      }
      retained.settledInputIds.delete(turnId);
    });
    // The runtime closed under durable input that has no outcome yet. Settling it
    // here would report a failure while another engine or restart recovery still
    // finishes it, so only this runtime's claim ends; the recovery input remains.
    const detach = Effect.fn("CakeSessionRuntimes.detachTurn")(function* (message: string) {
      yield* Ref.update(retained.activeTurns, (turns) => {
        const next = new Map(turns);
        next.delete(turnId);
        return next;
      });
      retained.turnResults.delete(turnId);
      yield* Effect.logWarning("Runtime closed before its accepted input settled", {
        sessionId: retained.runtime.sessionId,
        turnId,
        message,
      });
      yield* options.onTurnActivityChanged ?? Effect.void;
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
          cause instanceof TurnDetachedError
            ? detach(cause.message)
            : (cause instanceof TurnCanceledError
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
        if (!alreadyWorking) retained.activityTiming.startedAt = clock.currentTimeMillisUnsafe();
      }
      yield* Ref.update(retained.activeTurns, (turns) => new Map(turns).set(turnId, delivery));
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
      options.admitTurn
        ? options.admitTurn(
            { turnId, text, delivery, ...(internal === undefined ? null : { internal }) },
            accept,
          )
        : accept
    ).pipe(
      Effect.mapError(
        (cause) => new PiSessionError({ operation: delivery, message: String(cause) }),
      ),
      Effect.onExit((exit) =>
        Exit.isFailure(exit) ? Scope.close(turnScope, Exit.void) : Effect.void,
      ),
    );
    if (
      (options.profile._tag === "ProjectSession" || options.profile._tag === "AutomationSession") &&
      options.runtime.newSession
    ) {
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
                  (cause) => new PiSessionError({ operation: "abort", message: String(cause) }),
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
      deliverInput("steer", text, attachments, markdown, presentationMode, undefined, responseMode),
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
      const receipt = yield* retain().pipe(
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
    exportSideChatHistory: () =>
      call("exportSideChatHistory", (runtime) => {
        if (!runtime.exportSideChatHistory)
          throw new Error("This conversation cannot export side-chat history");
        return runtime.exportSideChatHistory();
      }),
    importSideChatHistory: (input) =>
      call("importSideChatHistory", (runtime) => {
        if (!runtime.importSideChatHistory)
          throw new Error("This conversation cannot import side-chat history");
        return runtime.importSideChatHistory(input);
      }),
    inspectSession: (query) => call("inspectSession", (runtime) => runtime.inspectSession(query)),
    history: (cursor) =>
      call("history", (runtime) => {
        if (!runtime.history) throw new Error("This conversation does not paginate history");
        return runtime.history(cursor);
      }),
    listQueuedMessages: () => call("listQueuedMessages", (runtime) => runtime.listQueuedMessages()),
    pendingMessages: () => call("pendingMessages", (runtime) => runtime.pendingMessages()),
    reorderPendingMessage: (input) =>
      editQueue("reorderPendingMessage", (runtime) => runtime.reorderPendingMessage(input)),
    clearQueue: () => editQueue("clearQueue", (runtime) => runtime.clearQueue()),
    cancelSteering: () => editQueue("cancelSteering", (runtime) => runtime.cancelSteering()),
    updateQueuedMessage: (partId, text) =>
      editQueue("updateQueuedMessage", (runtime) => runtime.updateQueuedMessage(partId, text)),
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
      const claimed = yield* claimAbortedTurns(shared.runtime.executingTurnIds?.() ?? []);
      // Cancellation must not queue behind recovery-file writes or turn admission.
      yield* call("abort", (runtime) => runtime.abort(stop));
      yield* recoveryGate
        .withPermit(
          Effect.gen(function* () {
            const record = yield* recoveryStorage.get(shared.runtime.sessionId);
            if (record) yield* recoveryStorage.update({ ...record, state: "stopped" });
          }),
        )
        .pipe(sessionError("abort"));
      // This settles accepted work, not provider/tool cleanup. The adapter fences
      // the stopped run and keeps the runtime reserved until cleanup actually ends.
      yield* settleAbortedTurns(claimed, stop);
    }),
    executeCommand: (command, arguments_) =>
      command === "changelog"
        ? changelog().pipe(
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
        ? call("setFastMode", (runtime) => runtime.setFastMode?.(enabled) ?? Promise.resolve())
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
    toolCompactIfIdle: Effect.fn("CakeSessionRuntimes.toolCompactIfIdle")(function* () {
      if ((yield* Ref.get(shared.activeTurns)).size > 0) return { status: "busy" as const };
      return yield* call("toolCompactIfIdle", (runtime) => {
        if (!runtime.toolCompactIfIdle)
          throw new Error("Idle-only tool compaction is unavailable for this runtime");
        return runtime.toolCompactIfIdle();
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
          (runtime) => runtime.notifySubagentCompletion?.(json, completionId) ?? Promise.resolve(),
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
      (options.onSessionChanged ?? Effect.void).pipe(sessionError("publishSessionChanged")),
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
    callCakeTool: (command, input) =>
      shared.runtime.callCakeTool
        ? cancellableRuntimeOperation(
            "callCakeTool",
            (signal) =>
              shared.runtime.callCakeTool?.(command, input, signal) ??
              Promise.reject(new Error("Cake tool is unavailable")),
          )
        : Effect.fail(
            new PiSessionError({
              operation: "callCakeTool",
              message: "Cake tool is unavailable",
            }),
          ),
    dispatchExtensionCompanionAction: (id, action, value) =>
      shared.runtime.dispatchExtensionCompanionAction
        ? call(
            "dispatchExtensionCompanionAction",
            (runtime) =>
              runtime.dispatchExtensionCompanionAction?.(id, action, value) ?? Promise.resolve(),
          )
        : Effect.fail(
            new PiSessionError({
              operation: "dispatchExtensionCompanionAction",
              message: "Extension companions are unavailable",
            }),
          ),
  } satisfies CakeSessionHandle;
}
