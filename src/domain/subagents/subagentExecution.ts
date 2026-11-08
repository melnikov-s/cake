import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  Option,
  RcMap,
  Ref,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import { subagentLink } from "../../contracts/subagents/subagent-reference";
import {
  SubagentError,
  SubagentHandleId,
  type SubagentResult,
  type SubagentStartReceipt,
  type SubagentTask,
} from "../../contracts/subagents/subagent-data";
import {
  CakeSessionRuntimes,
  type CakeSessionRuntimeAcquireOptions,
} from "../../services/pi/CakeSessionRuntimes";
import { createSubagentParentTool } from "../../services/pi/subagent-parent-tool";
import {
  subagentSystemPrompt,
  researchSystemPrompt,
} from "../../services/pi/subagent-system-prompt";
import {
  SubagentCoordinator,
  removeHandle,
  updateHandle,
  type SubagentHandleState,
} from "../../services/subagents/SubagentCoordinator";
import { SubagentEnvironment } from "../../services/subagents/SubagentEnvironment";
import type { SubagentRecord } from "../../services/storage/SubagentStorage";
import { subagentTaskTitle } from "../../contracts/subagents/subagent-presentation";
import type { RuntimeRecoveryInput } from "../../services/storage/RuntimeRecoveryStorage";
import { asSubagentError as asError } from "./subagent-error-message";
import {
  MAX_HANDLES_PER_PARENT,
  type PreparedTask,
  delegatedMessage,
  forwardInputs,
  forwardMessages,
  withInputReferences,
  withMessageReferences,
} from "./subagentTaskPreparation";
import { checkpoint, mutateHandle, requireHandleById } from "./subagentHandleState";
import {
  jsonValue,
  projectParts,
  projectedPartId,
  snapshotResult,
  completeHandle,
  deliverCompletion,
  failHandle,
} from "./subagentCompletion";
import { expireWhenIdle } from "./subagentLifetime";
const HANDLE_LIFETIME = "30 minutes";
const systemPrompt = (task: SubagentTask) => subagentSystemPrompt(task.instructions);

export const observeTurn = Effect.fn("Subagents.observeTurn")(function* (
  handleId: SubagentHandleId,
  delivery: "prompt" | "steer" | "follow-up",
  recovering = false,
) {
  const handle = yield* requireHandleById(handleId);
  const piHandle = handle.piHandle;
  if (!piHandle)
    return yield* new SubagentError({
      operation: delivery,
      message: "The subagent is still starting",
    });
  const ready = yield* Deferred.make<void, SubagentError>();
  const settled = yield* Ref.make<ReadonlyMap<string, { outcome: string; message?: string }>>(
    new Map(),
  );
  const target = yield* Ref.make<Option.Option<string>>(Option.none());
  const targetSettled = yield* Deferred.make<
    { outcome: string; message?: string },
    SubagentError
  >();
  const consume = piHandle.updates.pipe(
    Stream.runForEach((update) =>
      Effect.gen(function* () {
        if (update._tag === "Snapshot") {
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            privateSessionId: update.snapshot.sessionId,
            streaming: update.snapshot.streaming,
            parts: projectParts(update.snapshot.parts),
            usage:
              update.snapshot.usage === undefined
                ? current.usage
                : jsonValue(update.snapshot.usage),
          }));
          yield* Deferred.succeed(ready, undefined);
          return;
        }
        const event = update.event;
        if (event.type === "snapshot-updated") {
          const issue = event.snapshot.parts.find(
            (part) =>
              part.id === "restart-recovery" && part.kind === "notice" && part.tone === "error",
          );
          if (issue?.kind === "notice") {
            yield* Deferred.fail(
              targetSettled,
              new SubagentError({ operation: "recover", message: issue.detail ?? issue.title }),
            );
            return;
          }
        }
        if (event.type === "snapshot-updated")
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            streaming: event.snapshot.streaming,
            parts: projectParts(event.snapshot.parts),
            usage:
              event.snapshot.usage === undefined ? current.usage : jsonValue(event.snapshot.usage),
          }));
        else if (event.type === "part-updated")
          yield* mutateHandle(handleId, (current) => {
            const partIdentity = Schema.Struct({ id: Schema.String });
            const byId = new Map(
              current.parts.flatMap((part) => {
                const decoded = Schema.decodeUnknownOption(partIdentity)(part);
                return Option.isSome(decoded) ? [[decoded.value.id, part] as const] : [];
              }),
            );
            byId.set(event.part.id, jsonValue(event.part));
            return { ...current, parts: [...byId.values()].slice(-10_000) };
          });
        else if (event.type === "part-removed")
          yield* mutateHandle(handleId, (current) =>
            current.status === "aborted"
              ? current
              : {
                  ...current,
                  parts: current.parts.filter((part) => projectedPartId(part) !== event.partId),
                },
          );
        else if (event.type === "streaming")
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            streaming: event.streaming,
          }));
        else if (event.type === "usage-updated")
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            usage: jsonValue(event.usage),
          }));
        else if (event.type === "turn-settled") {
          const settlement: { outcome: string; message?: string } =
            event.message === undefined
              ? { outcome: event.outcome }
              : { outcome: event.outcome, message: event.message };
          yield* Ref.update(settled, (values) => new Map(values).set(event.turnId, settlement));
          yield* mutateHandle(handleId, (current) => ({
            ...current,
            recovery: {
              ...current.recovery,
              pendingInputs: current.recovery.pendingInputs.filter(
                (input) => input.turnId !== event.turnId,
              ),
            },
          }));
          const currentTarget = yield* Ref.get(target);
          const current = yield* requireHandleById(handleId);
          const settlements = yield* Ref.get(settled);
          if (
            Option.isSome(currentTarget) &&
            current.recovery.pendingInputs.every((input) => settlements.has(input.turnId))
          )
            yield* Deferred.succeed(targetSettled, settlement);
        }
      }),
    ),
  );
  // Turns have no time limit. They end only when Pi settles them, when the worker is
  // aborted or closed, or when its runtime stops publishing updates (e.g. backend exit).
  const stopped = new SubagentError({
    operation: delivery,
    message: "The subagent runtime stopped before its turn settled",
  });
  const observer = yield* consume.pipe(
    Effect.exit,
    Effect.andThen(Deferred.fail(ready, stopped)),
    Effect.andThen(Deferred.fail(targetSettled, stopped)),
    Effect.forkChild,
  );
  yield* Deferred.await(ready);
  yield* checkpoint(handleId);
  // Handoff includes inputs accepted while waiting for a slot or assembling Pi.
  const coordinator = yield* SubagentCoordinator;
  const inputs = yield* SubscriptionRef.modify(
    coordinator.state,
    (state) =>
      [
        state.handles.get(handleId)?.recovery.pendingInputs ?? [],
        updateHandle(state, handleId, (current) => ({
          ...current,
          status: "running",
          activityRevision: current.activityRevision + 1,
        })),
      ] as const,
  );
  const firstInput = inputs[0];
  const turnId = inputs.at(-1)?.turnId;
  if (!firstInput || !turnId)
    return yield* new SubagentError({
      operation: "recover",
      message: "Worker has no accepted input to recover",
    });
  yield* (
    recovering || inputs.length > 1 ? piHandle.recover(inputs) : piHandle.submit(firstInput)
  ).pipe(asError(delivery));
  yield* Ref.set(target, Option.some(turnId));
  // Queue removal also changes the accepted set: do not wait forever for a
  // canceled follow-up after the preceding turn has already settled.
  const drained = SubscriptionRef.changes(coordinator.state).pipe(
    Stream.filter((state) => state.handles.get(handleId)?.recovery.pendingInputs.length === 0),
    Stream.runHead,
    Effect.flatMap(() => Ref.get(settled)),
    Effect.flatMap((values) => {
      const last = [...values.values()].at(-1);
      return last ? Effect.succeed(last) : Deferred.await(targetSettled);
    }),
  );
  const settlement = yield* Effect.raceFirst(drained, Deferred.await(targetSettled));
  yield* Fiber.interrupt(observer);
  const finalSnapshot = yield* piHandle.snapshot().pipe(asError(delivery));
  const current = yield* requireHandleById(handleId);
  const status =
    settlement.outcome === "complete"
      ? "complete"
      : settlement.outcome === "aborted"
        ? "aborted"
        : "error";
  return snapshotResult(current, finalSnapshot, status, settlement.message);
});

const executeInitial = Effect.fn("Subagents.executeInitial")(function* (
  handleId: SubagentHandleId,
  prepared: PreparedTask,
  restored?: SubagentRecord,
) {
  const coordinator = yield* SubagentCoordinator;
  const handle = yield* requireHandleById(handleId);
  const slot = yield* RcMap.get(coordinator.slots, prepared.workingDirectory).pipe(
    Effect.provideService(Scope.Scope, handle.scope),
  );
  yield* slot.withPermit(
    Effect.gen(function* () {
      const current = yield* requireHandleById(handleId);
      const sessions = yield* CakeSessionRuntimes;
      const piHandle =
        current.piHandle ??
        (yield* sessions
          .acquire(current.runtimeOptions)
          .pipe(Effect.provideService(Scope.Scope, current.scope), asError("start")));
      yield* mutateHandle(handleId, (value) => ({ ...value, piHandle }));
      const initial = yield* piHandle.snapshot().pipe(asError("start"));
      yield* mutateHandle(handleId, (value) => ({
        ...value,
        privateSessionId: initial.sessionId,
        streaming: initial.streaming,
        parts: projectParts(initial.parts),
      }));
      const selected =
        initial.model?.provider === prepared.resolvedModel.provider &&
        initial.model.id === prepared.resolvedModel.modelId &&
        initial.thinkingLevel === prepared.resolvedModel.thinkingLevel;
      if (!selected) {
        yield* piHandle
          .setModel(prepared.resolvedModel.provider, prepared.resolvedModel.modelId)
          .pipe(asError("start"));
        yield* piHandle
          .setThinkingLevel(prepared.resolvedModel.thinkingLevel)
          .pipe(asError("start"));
      }
      if (prepared.input.preset)
        yield* piHandle
          .applyConfiguration({
            provider: prepared.resolvedModel.provider,
            modelId: prepared.resolvedModel.modelId,
            thinkingLevel: prepared.resolvedModel.thinkingLevel,
            fastMode: prepared.input.fastMode,
            preset: prepared.input.preset,
          })
          .pipe(asError("start"));
      else if (prepared.input.fastMode) yield* piHandle.setFastMode(true).pipe(asError("start"));
      const result = yield* observeTurn(handleId, "prompt", restored !== undefined);
      yield* completeHandle(handleId, result);
    }),
  );
});

export const startPrepared = Effect.fn("Subagents.startPrepared")(function* (
  prepared: PreparedTask,
  anchorPartId: string,
  notifyOnCompletion: boolean,
  restored?: SubagentRecord,
  transcriptExpected = false,
  activate: Effect.Effect<void> = Effect.void,
) {
  const coordinator = yield* SubagentCoordinator;
  const environment = yield* SubagentEnvironment;
  const sessions = yield* CakeSessionRuntimes;
  const location = yield* environment.location(prepared.workingDirectory).pipe(asError("start"));
  const handleId = restored?.handleId ?? SubagentHandleId.make(crypto.randomUUID());
  const lazy =
    restored !== undefined &&
    restored.status !== "queued" &&
    restored.status !== "running" &&
    (restored.completionDisposition === "notified" || restored.completionDisposition === "waited");
  const scope = yield* Scope.make();
  return yield* Effect.gen(function* () {
    const completion = yield* Deferred.make<SubagentResult, SubagentError>();
    const acquireParent = yield* Effect.cached(
      sessions
        .acquire(prepared.parent.options)
        .pipe(Effect.provideService(Scope.Scope, scope), asError("start")),
    );
    const parentHandle = lazy ? undefined : yield* acquireParent;
    const parentMessage = (text: string) =>
      prepared.parent.runEffect(
        acquireParent.pipe(
          Effect.flatMap((parent) =>
            parent.submit({
              turnId: crypto.randomUUID(),
              delivery: "follow-up",
              text: `Message from subagent ${handleId} (${prepared.input.task.slice(0, 500)}):\n\n${text}\n\nReply through this subagent's handle if a response is needed.`,
              attachments: [],
              markdown: true,
              internal: {
                _tag: "AgentUpdate",
                update: {
                  id: crypto.randomUUID(),
                  text,
                  source: {
                    title: subagentTaskTitle(prepared.input.task),
                    href: subagentLink(prepared.parent.parentSessionId, handleId),
                  },
                },
              },
            }),
          ),
          asError("messageParent"),
          Effect.asVoid,
        ),
      );
    const recipientSessionId = restored?.privateSessionId ?? crypto.randomUUID();
    if (prepared.initializeContext && !restored)
      yield* prepared.initializeContext(recipientSessionId);
    const attachmentAccess = prepared.parent.attachments?.(
      prepared.parent.parentSessionId,
      recipientSessionId,
    );
    const inputReferences =
      restored?.inputReferences ??
      (yield* forwardInputs(attachmentAccess, prepared.input.inputRefs));
    const messageAccess = prepared.parent.messages?.(recipientSessionId);
    const messageReferences = yield* forwardMessages(
      messageAccess,
      restored?.messageReferences ?? prepared.input.messageRefs,
    );
    const tools =
      attachmentAccess || messageAccess
        ? [...new Set([...prepared.tools, "cake"])]
        : prepared.tools;
    const persisted =
      restored && !lazy
        ? yield* sessions
            .catalogEntry(
              {
                workingDirectory: location.workingDirectory,
                sessionDirectory: restored?.privateSessionDirectory ?? location.sessionDirectory,
              },
              recipientSessionId,
            )
            .pipe(asError("restore"))
        : undefined;
    const runtimeOptions: CakeSessionRuntimeAcquireOptions = {
      profile: { _tag: "SubagentSession" },
      runtime: {
        cwd: location.workingDirectory,
        agentDir: location.agentDirectory,
        sessionDir: restored?.privateSessionDirectory ?? location.sessionDirectory,
        newSession:
          !prepared.initializeContext && !lazy && persisted === undefined && !transcriptExpected,
        sessionId: recipientSessionId,
        auxiliary: true,
        // Nobody can compact a background worker by hand, so it never inherits the
        // user's Project Session auto-compact choice.
        alwaysAutoCompact: true,
        ...(prepared.input.projectPath
          ? {
              projectInvestigation: true,
              allowMutations: prepared.input.allowMutations,
            }
          : { tools: [...tools] }),
        customTools: [createSubagentParentTool({ send: parentMessage })],
        slashCommands: [],
        isolatedSystemPrompt: prepared.input.projectPath
          ? undefined
          : prepared.parent.options.profile._tag === "CakeChatSession"
            ? researchSystemPrompt({ allowMutations: prepared.input.allowMutations })
            : systemPrompt(prepared.input),
        requestUi: async () => undefined,
        fastMode: {
          get: () => prepared.input.fastMode,
          set: async () => undefined,
        },
      },
    };
    const allowedCakeOperations: string[] = [];
    if (attachmentAccess) {
      runtimeOptions.runtime.attachmentReferenceControl = attachmentAccess.control;
      allowedCakeOperations.push("attachments.list", "attachments.read");
    }
    if (messageAccess) {
      runtimeOptions.runtime.messageReferenceControl = messageAccess.control;
      allowedCakeOperations.push("messages.read");
    }
    runtimeOptions.runtime.allowedCakeOperations = allowedCakeOperations;
    const assignment =
      prepared.parent.options.profile._tag === "CakeChatSession" && prepared.input.instructions
        ? `Assignment guidance (subject to your ${prepared.input.allowMutations ? "scoped mutation-mode" : "investigation-only"} system instructions):\n${prepared.input.instructions}\n\nTask:\n${prepared.input.task}`
        : prepared.input.task;
    const initialInputs: readonly RuntimeRecoveryInput[] = restored?.pendingInputs ?? [
      {
        turnId: crypto.randomUUID(),
        text: yield* delegatedMessage(
          withMessageReferences(
            withInputReferences(assignment, inputReferences),
            messageReferences,
          ),
          prepared.parent.parentSessionId,
          prepared.parent.options.profile._tag === "CakeChatSession"
            ? "CakeChatSession"
            : "ProjectSession",
          prepared.parent.workingDirectory,
          prepared.parent.options.runtime.sessionDir,
        ),
        delivery: "prompt",
        attachments: [],
        markdown: false,
      },
    ];
    const hydrate = lazy
      ? yield* Effect.cached(
          Effect.fn("Subagents.hydrate")(function* () {
            const current = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
            if (!current || current.piHandle) return;
            const parentPiHandle = yield* acquireParent;
            const piHandle = yield* sessions
              .acquire(runtimeOptions)
              .pipe(Effect.provideService(Scope.Scope, scope), asError("restore"));
            const snapshot = yield* piHandle.snapshot().pipe(asError("restore"));
            const result = snapshotResult(current, snapshot, current.status, current.error);
            yield* SubscriptionRef.update(coordinator.state, (state) =>
              updateHandle(state, handleId, (value) => ({
                ...value,
                parentPiHandle,
                piHandle,
                result,
                parts: result.parts,
                usage: result.usage,
                activityRevision: value.activityRevision + 1,
              })),
            );
            yield* Deferred.succeed(completion, result);
          })(),
        )
      : undefined;
    const handle: SubagentHandleState = {
      handleId,
      hydrate,
      recovery: restored ?? {
        handleId,
        privateSessionId: recipientSessionId,
        privateSessionDirectory: location.sessionDirectory,
        parentSessionId: prepared.parent.parentSessionId,
        parentProfile:
          prepared.parent.options.profile._tag === "CakeChatSession"
            ? "CakeChatSession"
            : "ProjectSession",
        parentWorkingDirectory: prepared.parent.workingDirectory,
        parentSessionDirectory: prepared.parent.options.runtime.sessionDir,
        anchorPartId,
        workingDirectory: prepared.workingDirectory,
        ...(prepared.input.projectPath ? { projectPath: prepared.input.projectPath } : null),
        task: prepared.input.task,
        ...(prepared.input.instructions === undefined
          ? null
          : { instructions: prepared.input.instructions }),
        allowMutations: prepared.input.allowMutations,
        resolvedModel: prepared.resolvedModel,
        ...(prepared.input.preset ? { preset: prepared.input.preset } : null),
        fastMode: prepared.input.fastMode,
        tools,
        inputReferences,
        messageReferences,
        continuation: prepared.input.continuation,
        notifyOnCompletion,
        completionId: crypto.randomUUID(),
        completionDisposition: notifyOnCompletion ? "pending" : "waited",
        status: "queued",
        pendingInputs: initialInputs,
      },
      privateSessionId: recipientSessionId,
      parentSessionId: prepared.parent.parentSessionId,
      anchorPartId,
      workingDirectory: prepared.workingDirectory,
      projectPath: prepared.input.projectPath,
      task: prepared.input.task,
      resolvedModel: prepared.resolvedModel,
      tools,
      instructions: prepared.input.instructions,
      fastMode: prepared.input.fastMode,
      scope,
      completion,
      runtimeOptions,
      parentPiHandle: parentHandle,
      attachmentAccess,
      inputReferences,
      messageAccess,
      messageReferences,
      status: restored?.status ?? "queued",
      ...(restored?.error === undefined ? null : { error: restored.error }),
      ...(restored?.failurePhase === undefined ? null : { failurePhase: restored.failurePhase }),
      activityRevision: 0,
      streaming: false,
      parts: [],
      waiters: 0,
      completionDisposition:
        restored?.completionDisposition ?? (notifyOnCompletion ? "pending" : "waited"),
    };
    const inserted = yield* SubscriptionRef.modify(coordinator.state, (state) => {
      const owned = [...state.handles.values()].filter(
        (item) => item.parentSessionId === prepared.parent.parentSessionId,
      ).length;
      if (owned >= MAX_HANDLES_PER_PARENT) return [false, state] as const;
      const handles = new Map(state.handles);
      handles.set(handleId, handle);
      return [true, { revision: state.revision + 1, handles }] as const;
    });
    if (!inserted)
      return yield* new SubagentError({
        operation: "start",
        message: `An agent may own at most ${MAX_HANDLES_PER_PARENT} subagent handles.`,
      });
    if (!lazy) yield* checkpoint(handleId);
    const hydration =
      restored && !lazy
        ? yield* sessions.acquire(runtimeOptions).pipe(
            Effect.provideService(Scope.Scope, scope),
            asError("restore"),
            Effect.tap((piHandle) => mutateHandle(handleId, (value) => ({ ...value, piHandle }))),
            Effect.exit,
          )
        : undefined;
    const terminal = restored && restored.status !== "queued" && restored.status !== "running";
    if (terminal && hydration && Exit.isSuccess(hydration)) {
      const snapshot = yield* hydration.value.snapshot().pipe(asError("restore"));
      const result = snapshotResult(handle, snapshot, restored.status, restored.error);
      yield* mutateHandle(handleId, (value) => ({
        ...value,
        result,
        parts: result.parts,
        usage: result.usage,
        streaming: false,
        completionDisposition:
          restored.completionDisposition === "pending"
            ? "notifying"
            : restored.completionDisposition,
      }));
      yield* checkpoint(handleId);
      yield* Deferred.succeed(completion, result);
    }
    const resume =
      hydration && Exit.isFailure(hydration)
        ? failHandle(handleId, hydration.cause)
        : terminal
          ? deliverCompletion(handleId)
          : executeInitial(handleId, prepared, restored);
    const worker = activate.pipe(Effect.andThen(resume)).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => Effect.void,
        onFailure: (cause) => failHandle(handleId, cause),
      }),
    );
    if (!lazy) yield* FiberMap.run(coordinator.fibers, handleId, worker);
    if (prepared.parent.options.profile._tag === "CakeChatSession") {
      const expiry = yield* Effect.sleep(HANDLE_LIFETIME).pipe(
        Effect.andThen(expireWhenIdle(handleId)),
        Effect.forkIn(coordinator.scope),
      );
      yield* Scope.addFinalizer(
        scope,
        Effect.withFiber((fiber) =>
          fiber.id === expiry.id ? Effect.void : Fiber.interrupt(expiry),
        ),
      );
    }
    const receipt: SubagentStartReceipt = {
      continuation: prepared.input.continuation,
      handleId,
      task: prepared.input.task,
      status: "queued",
      fastMode: prepared.input.fastMode,
      resolvedModel: prepared.resolvedModel,
    };
    if (prepared.input.projectPath)
      Object.assign(receipt, { projectPath: prepared.input.projectPath });
    return { handleId, receipt };
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isFailure(exit)
        ? SubscriptionRef.update(coordinator.state, (state) => removeHandle(state, handleId)).pipe(
            Effect.andThen(FiberMap.remove(coordinator.fibers, handleId)),
            Effect.andThen(Scope.close(scope, Exit.void)),
          )
        : Effect.void,
    ),
  );
});
