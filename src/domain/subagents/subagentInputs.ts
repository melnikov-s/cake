import {
  Deferred,
  Effect,
  Exit,
  FiberMap,
  RcMap,
  Ref,
  Schema,
  Scope,
  SubscriptionRef,
} from "effect";
import type { ParentContinuation } from "../../contracts/conversations/parent-continuation";
import {
  SubagentError,
  SubagentHandleId,
  type SubagentResult,
} from "../../contracts/subagents/subagent-data";
import {
  SubagentCoordinator,
  queuedWorkerInputId,
  updateHandle,
} from "../../services/subagents/SubagentCoordinator";
import type { RuntimeRecoveryInput } from "../../services/storage/RuntimeRecoveryStorage";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import type { AttachmentReadInput } from "../../contracts/conversations/attachment-reference-control";
import { asSubagentError as asError } from "./subagent-error-message";
import { checkpoint, mutateHandle, requireHandle } from "./subagentHandleState";
import {
  delegatedMessage,
  forwardInputs,
  forwardMessages,
  withInputReferences,
  withMessageReferences,
} from "./subagentTaskPreparation";
import {
  jsonValue,
  projectParts,
  parentResult,
  completeHandle,
  failHandle,
} from "./subagentCompletion";
import { observeTurn } from "./subagentExecution";

export const prompt = Effect.fn("Subagents.prompt")(function* (
  parentSessionId: string,
  rawHandleId: string,
  text: string,
  delivery: "prompt" | "follow-up",
  background = false,
  inputRefs?: readonly string[],
  messageRefs?: readonly string[],
  continuation?: ParentContinuation,
  author: "user" | "assistant" = "user",
  userInput?: { turnId: string; markdown: boolean },
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  const normalized = text.trim();
  if (!normalized)
    return yield* new SubagentError({ operation: delivery, message: "Prompt text is required" });
  if (handle.status === "queued" || handle.status === "running")
    return yield* new SubagentError({
      operation: delivery,
      message: "That subagent already has active work; steer or abort it instead",
    });
  const inputReferences = yield* forwardInputs(handle.attachmentAccess, inputRefs);
  const messageReferences = yield* forwardMessages(handle.messageAccess, messageRefs);
  const coordinator = yield* SubagentCoordinator;
  const completion = yield* Deferred.make<SubagentResult, SubagentError>();
  const message = withMessageReferences(
    withInputReferences(normalized, inputReferences),
    messageReferences,
  );
  const input: RuntimeRecoveryInput = {
    turnId: userInput?.turnId ?? crypto.randomUUID(),
    text:
      author === "assistant"
        ? yield* delegatedMessage(
            message,
            parentSessionId,
            handle.recovery.parentProfile,
            handle.recovery.parentWorkingDirectory,
            handle.recovery.parentSessionDirectory,
          )
        : message,
    delivery,
    attachments: [],
    markdown: userInput?.markdown ?? false,
  };
  const claimed = yield* SubscriptionRef.modify(coordinator.state, (state) => {
    const current = state.handles.get(handle.handleId);
    if (
      !current ||
      current.parentSessionId !== parentSessionId ||
      current.status === "queued" ||
      current.status === "running"
    )
      return [false, state] as const;
    return [
      true,
      updateHandle(state, handle.handleId, (value) => ({
        ...value,
        status: "queued",
        error: undefined,
        result: undefined,
        completion,
        inputReferences: [
          ...new Map(
            [...value.inputReferences, ...inputReferences].map((ref) => [ref.id, ref]),
          ).values(),
        ],
        messageReferences: [...new Set([...value.messageReferences, ...messageReferences])],
        recovery: {
          ...value.recovery,
          completionId: crypto.randomUUID(),
          pendingInputs: [input],
          notifyOnCompletion: background && !userInput ? true : value.recovery.notifyOnCompletion,
          continuation: continuation ?? value.recovery.continuation ?? "none",
        },
        completionDisposition: background && !userInput ? "pending" : "waited",
        activityRevision: value.activityRevision + 1,
      })),
    ] as const;
  });
  if (!claimed)
    return yield* new SubagentError({
      operation: delivery,
      message: "That subagent already has active work; steer or abort it instead",
    });
  yield* checkpoint(handle.handleId);
  const slot = yield* RcMap.get(coordinator.slots, handle.workingDirectory).pipe(
    Effect.provideService(Scope.Scope, handle.scope),
  );
  const execute = slot.withPermit(observeTurn(handle.handleId, delivery)).pipe(
    Effect.onInterrupt(() =>
      Effect.gen(function* () {
        if (yield* Ref.get(coordinator.shuttingDown)) return;
        if (handle.piHandle) yield* handle.piHandle.abort().pipe(Effect.ignore);
      }),
    ),
  );
  if (background) {
    yield* FiberMap.run(
      coordinator.fibers,
      handle.handleId,
      execute.pipe(
        Effect.matchCauseEffect({
          onSuccess: (result) => completeHandle(handle.handleId, result),
          onFailure: (cause) => failHandle(handle.handleId, cause),
        }),
      ),
    );
    return jsonValue({
      continuation: continuation ?? handle.recovery.continuation ?? "none",
      handleId: handle.handleId,
      task: handle.task,
      projectPath: handle.projectPath,
      status: "queued",
      fastMode: handle.fastMode,
      resolvedModel: handle.resolvedModel,
    });
  }
  const result = yield* execute.pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? completeHandle(handle.handleId, exit.value)
        : Ref.get(coordinator.shuttingDown).pipe(
            Effect.flatMap((stopping) =>
              stopping ? Effect.void : failHandle(handle.handleId, exit.cause),
            ),
          ),
    ),
  );
  return jsonValue(parentResult(handle, result));
});

export const readAttachment = Effect.fn("Subagents.readAttachment")(function* (
  input: AttachmentReadInput & { parentSessionId: string; handleId: string },
) {
  const handleId = yield* Schema.decodeUnknownEffect(SubagentHandleId)(input.handleId).pipe(
    asError("readAttachment"),
  );
  const coordinator = yield* SubagentCoordinator;
  const live = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
  const saved = yield* coordinator.storage.history.get(handleId);
  const owner = live
    ? { parentSessionId: live.parentSessionId, privateSessionId: live.recovery.privateSessionId }
    : saved;
  if (!owner || owner.parentSessionId !== input.parentSessionId)
    return yield* new SubagentError({
      operation: "readAttachment",
      message: "That subagent handle does not belong to this parent session",
    });
  const storage = yield* TaskInputStorage;
  return yield* storage.inspect(owner.privateSessionId, input).pipe(asError("readAttachment"));
});

/** Human UI admission is queue-first. Agent tool prompt/steer policy is deliberately separate. */
export const submitUserInput = Effect.fn("Subagents.submitUserInput")(function* (input: {
  parentSessionId: string;
  handleId: string;
  text: string;
  renderUserMessageAsMarkdown: boolean;
}) {
  const handle = yield* requireHandle(input.parentSessionId, input.handleId);
  const text = input.text.trim();
  if (!text)
    return yield* new SubagentError({ operation: "submit", message: "Prompt text is required" });
  const turnId = crypto.randomUUID();
  if (handle.status !== "running" && handle.status !== "queued") {
    yield* prompt(
      input.parentSessionId,
      input.handleId,
      text,
      "prompt",
      true,
      undefined,
      undefined,
      undefined,
      "user",
      { turnId, markdown: input.renderUserMessageAsMarkdown },
    );
  } else {
    const accepted: RuntimeRecoveryInput = {
      turnId,
      text,
      delivery: "follow-up",
      attachments: [],
      markdown: input.renderUserMessageAsMarkdown,
    };
    const coordinator = yield* SubagentCoordinator;
    const runtime = yield* SubscriptionRef.modify(
      coordinator.state,
      (state) =>
        [
          state.handles.get(handle.handleId)?.status === "running"
            ? state.handles.get(handle.handleId)?.piHandle
            : undefined,
          updateHandle(state, handle.handleId, (current) => ({
            ...current,
            activityRevision: current.activityRevision + 1,
            recovery: {
              ...current.recovery,
              pendingInputs: [...current.recovery.pendingInputs, accepted],
            },
          })),
        ] as const,
    );
    if (runtime)
      yield* runtime.submit(accepted).pipe(
        asError("submit"),
        Effect.onError(() =>
          mutateHandle(handle.handleId, (current) => ({
            ...current,
            recovery: {
              ...current.recovery,
              pendingInputs: current.recovery.pendingInputs.filter(
                (item) => item.turnId !== turnId,
              ),
            },
          })),
        ),
      );
    yield* checkpoint(handle.handleId);
  }
  return { turnId };
});

export const editQueuedUserInput = Effect.fn("Subagents.editQueuedUserInput")(function* (input: {
  parentSessionId: string;
  handleId: string;
  partId: string;
  operation: "remove" | "steer" | "send-now" | "reorder" | "update";
  text?: string;
  itemId?: string;
  position?: number;
}) {
  if (input.operation === "update" && input.text === undefined)
    return yield* new SubagentError({
      operation: input.operation,
      message: "Message text is required",
    });
  const handle = yield* requireHandle(input.parentSessionId, input.handleId);
  if (handle.status === "queued") {
    const pending = handle.recovery.pendingInputs
      .slice(1)
      .find((entry) => queuedWorkerInputId(entry.turnId) === input.partId);
    if (!pending || (input.operation !== "remove" && input.operation !== "update"))
      return yield* new SubagentError({
        operation: input.operation,
        message:
          "Only canceling or editing a queued follow-up is available before the worker starts",
      });
    const coordinator = yield* SubagentCoordinator;
    const removed = yield* SubscriptionRef.modify(coordinator.state, (state) => {
      if (state.handles.get(handle.handleId)?.status !== "queued") return [false, state] as const;
      return [
        true,
        updateHandle(state, handle.handleId, (current) => ({
          ...current,
          activityRevision: current.activityRevision + 1,
          recovery: {
            ...current.recovery,
            pendingInputs:
              input.operation === "update"
                ? current.recovery.pendingInputs.map((entry) =>
                    entry.turnId === pending.turnId
                      ? { ...entry, text: input.text ?? entry.text }
                      : entry,
                  )
                : current.recovery.pendingInputs.filter((entry) => entry.turnId !== pending.turnId),
          },
        })),
      ] as const;
    });
    if (!removed)
      return yield* new SubagentError({
        operation: input.operation,
        message: "The worker has started; retry canceling its queued follow-up",
      });
    yield* checkpoint(handle.handleId);
    return;
  }
  const runtime = handle.piHandle;
  if (!runtime)
    return yield* new SubagentError({
      operation: input.operation,
      message: "The subagent is unavailable",
    });
  const snapshot = yield* runtime.snapshot().pipe(asError(input.operation));
  const part = snapshot.parts.find((part) => part.id === input.partId);
  if (
    part?.kind !== "text" ||
    part.role !== "user" ||
    !part.queuedInput ||
    part.crossSession ||
    part.scheduled
  )
    return yield* new SubagentError({
      operation: input.operation,
      message: "That queued input is unavailable",
    });
  if (input.operation === "remove") {
    yield* runtime.removeQueuedMessage(input.partId).pipe(asError(input.operation));
    yield* mutateHandle(handle.handleId, (current) => ({
      ...current,
      recovery: {
        ...current.recovery,
        pendingInputs: current.recovery.pendingInputs.filter(
          (item) => item.turnId !== part.queuedInput?.turnId,
        ),
      },
    }));
  } else if (input.operation === "update") {
    yield* runtime
      .updateQueuedMessage(input.partId, input.text ?? "")
      .pipe(asError(input.operation));
    yield* mutateHandle(handle.handleId, (current) => ({
      ...current,
      recovery: {
        ...current.recovery,
        pendingInputs: current.recovery.pendingInputs.map((item) =>
          item.turnId === part.queuedInput?.turnId
            ? { ...item, text: input.text ?? item.text }
            : item,
        ),
      },
    }));
  } else if (input.operation === "steer") {
    yield* runtime.steerQueuedMessage(input.partId).pipe(asError(input.operation));
    yield* mutateHandle(handle.handleId, (current) => ({
      ...current,
      recovery: {
        ...current.recovery,
        pendingInputs: current.recovery.pendingInputs.map((item) =>
          item.turnId === part.queuedInput?.turnId ? { ...item, delivery: "steer" } : item,
        ),
      },
    }));
  } else if (input.operation === "send-now")
    yield* runtime.sendQueuedMessageNow(input.partId).pipe(asError(input.operation));
  else {
    if (!input.itemId || input.position === undefined || input.itemId !== part.queuedInput.itemId)
      return yield* new SubagentError({
        operation: input.operation,
        message: "Queue item and position are required",
      });
    yield* runtime
      .reorderPendingMessage({ itemId: input.itemId, position: input.position })
      .pipe(asError(input.operation));
    const pending = yield* runtime.pendingMessages().pipe(asError(input.operation));
    const turnIds = pending.items.flatMap((item) => {
      const queued = snapshot.parts.find(
        (part) => part.kind === "text" && part.queuedInput?.itemId === item.itemId,
      );
      return queued?.kind === "text" && queued.queuedInput?.turnId
        ? [queued.queuedInput.turnId]
        : [];
    });
    yield* mutateHandle(handle.handleId, (current) => ({
      ...current,
      recovery: {
        ...current.recovery,
        pendingInputs: [
          ...current.recovery.pendingInputs.filter((item) => !turnIds.includes(item.turnId)),
          ...turnIds.flatMap((id) =>
            current.recovery.pendingInputs.filter((item) => item.turnId === id),
          ),
        ],
      },
    }));
  }
  const updated = yield* runtime.snapshot().pipe(asError(input.operation));
  yield* mutateHandle(handle.handleId, (current) => ({
    ...current,
    parts: projectParts(updated.parts),
  }));
  yield* checkpoint(handle.handleId);
});

export const setUserMessageMarkdown = Effect.fn("Subagents.setUserMessageMarkdown")(
  function* (input: {
    parentSessionId: string;
    handleId: string;
    entryId: string;
    renderAsMarkdown: boolean;
  }) {
    const handle = yield* requireHandle(input.parentSessionId, input.handleId);
    if (!handle.piHandle)
      return yield* new SubagentError({
        operation: "setUserMessageMarkdown",
        message: "The subagent is unavailable",
      });
    yield* handle.piHandle
      .setUserMessageMarkdown(input.entryId, input.renderAsMarkdown)
      .pipe(asError("setUserMessageMarkdown"));
    const snapshot = yield* handle.piHandle.snapshot().pipe(asError("setUserMessageMarkdown"));
    yield* mutateHandle(handle.handleId, (current) => ({
      ...current,
      parts: projectParts(snapshot.parts),
    }));
  },
);

export const steer = Effect.fn("Subagents.steer")(function* (
  parentSessionId: string,
  rawHandleId: string,
  text: string,
) {
  const handle = yield* requireHandle(parentSessionId, rawHandleId);
  if (handle.status !== "running" || !handle.piHandle)
    return yield* new SubagentError({
      operation: "steer",
      message: "That subagent is no longer available to steer",
    });
  const normalized = text.trim();
  if (!normalized)
    return yield* new SubagentError({ operation: "steer", message: "Steer text is required" });
  const input: RuntimeRecoveryInput = {
    turnId: crypto.randomUUID(),
    text: normalized,
    delivery: "steer",
    attachments: [],
    markdown: false,
  };
  yield* mutateHandle(handle.handleId, (current) => ({
    ...current,
    recovery: { ...current.recovery, pendingInputs: [...current.recovery.pendingInputs, input] },
  }));
  yield* checkpoint(handle.handleId);
  yield* handle.piHandle.submit(input).pipe(asError("steer"));
});
