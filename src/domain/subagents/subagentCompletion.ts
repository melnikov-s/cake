import { Cause, Deferred, Effect, Option, Ref, Schema, SubscriptionRef } from "effect";
import {
  uiPartSchema,
  type ConversationSnapshot,
} from "../../contracts/conversations/session-contract";
import * as projectTodoUpdates from "../projects/projectTodoUpdates";
import { subagentFinalAnswerPart } from "../../contracts/subagents/subagent-report";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";
import type { SubagentHandleId } from "../../contracts/subagents/subagent-data";
import { SubagentError, type SubagentResult } from "../../contracts/subagents/subagent-data";
import {
  SubagentCoordinator,
  updateHandle,
  type SubagentHandleState,
} from "../../services/subagents/SubagentCoordinator";
import { asSubagentError as asError } from "./subagent-error-message";
import { checkpoint, mutateHandle, requireHandleById } from "./subagentHandleState";

export const jsonValue = <A>(value: A): Schema.Schema.Type<typeof Schema.Json> =>
  Schema.decodeUnknownSync(Schema.Json)(JSON.parse(JSON.stringify(value)));
export const projectParts = (parts: ConversationSnapshot["parts"]) =>
  parts.slice(-10_000).map(jsonValue);
export const projectedPartId = (part: Schema.Schema.Type<typeof Schema.Json>) => {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))(part);
  return Option.isSome(decoded) ? decoded.value.id : undefined;
};
const preserveAbortedParts = (
  existing: ReadonlyArray<Schema.Schema.Type<typeof Schema.Json>>,
  final: ReadonlyArray<Schema.Schema.Type<typeof Schema.Json>>,
) => {
  const merged = [...existing];
  const indexes = new Map(
    merged.flatMap((part, index) => {
      const id = projectedPartId(part);
      return id === undefined ? [] : [[id, index] as const];
    }),
  );
  for (const part of final) {
    const id = projectedPartId(part);
    const index = id === undefined ? undefined : indexes.get(id);
    if (index === undefined) {
      if (id !== undefined) indexes.set(id, merged.length);
      merged.push(part);
    } else merged[index] = part;
  }
  return merged.slice(-10_000);
};
export const boundedError = (message: string) => message.slice(0, 16_384);

/** Only the compact final answer may cross into Cake Chat's durable tool/report history. */
export const parentResult = (
  handle: SubagentHandleState,
  result: SubagentResult,
): SubagentResult => {
  if (handle.recovery.parentProfile !== "CakeChatSession") return result;
  if (result.status !== "complete") return { ...result, parts: [] };
  const answer = result.parts
    .flatMap((part) => {
      const parsed = Schema.decodeUnknownOption(uiPartSchema)(part);
      return Option.isSome(parsed) &&
        parsed.value.kind === "text" &&
        parsed.value.role === "assistant"
        ? [parsed.value]
        : [];
    })
    .findLast((part) => part.text.trim());
  return {
    ...result,
    parts: answer
      ? [
          {
            id: answer.id,
            kind: "text",
            role: "assistant",
            status: answer.status,
            text: answer.text.slice(0, 16_000),
          },
        ]
      : [],
  };
};

export const snapshotResult = (
  handle: SubagentHandleState,
  snapshot: ConversationSnapshot,
  status: SubagentResult["status"],
  error?: string,
): SubagentResult => {
  const finalParts = projectParts(snapshot.parts);
  const result: SubagentResult = {
    handleId: handle.handleId,
    task: handle.task,
    status,
    resolvedModel: handle.resolvedModel,
    fastMode: handle.fastMode,
    streaming: snapshot.streaming,
    parts: status === "aborted" ? preserveAbortedParts(handle.parts, finalParts) : finalParts,
  };
  if (handle.projectPath) Object.assign(result, { projectPath: handle.projectPath });
  if (snapshot.usage !== undefined) Object.assign(result, { usage: jsonValue(snapshot.usage) });
  if (error !== undefined) Object.assign(result, { error: boundedError(error) });
  return result;
};

export const completeHandle = Effect.fn("Subagents.completeHandle")(function* (
  handleId: SubagentHandleId,
  result: SubagentResult,
) {
  const coordinator = yield* SubagentCoordinator;
  const shouldNotify = yield* SubscriptionRef.modify(coordinator.state, (state) => {
    const current = state.handles.get(handleId);
    if (!current || current.result) return [false, state] as const;
    const notify =
      current.recovery.notifyOnCompletion &&
      current.waiters === 0 &&
      (current.completionDisposition === "pending" ||
        current.completionDisposition === "notifying");
    const next: SubagentHandleState = {
      ...current,
      status: result.status,
      streaming: result.streaming,
      parts: result.parts,
      usage: result.usage,
      error: result.error,
      failurePhase: result.failurePhase,
      result,
      recovery: { ...current.recovery, pendingInputs: [] },
      completionDisposition:
        current.completionDisposition === "notified" ? "notified" : notify ? "notifying" : "waited",
      activityRevision: current.activityRevision + 1,
    };
    return [notify, updateHandle(state, handleId, () => next)] as const;
  });
  const handle = (yield* SubscriptionRef.get(coordinator.state)).handles.get(handleId);
  if (!handle) return;
  yield* checkpoint(handleId);
  yield* Deferred.succeed(handle.completion, result);
  // A failed worker's last text is mid-task narration; its error is the report.
  const report =
    result.status === "error"
      ? result.error || subagentFinalAnswerPart(result)?.text
      : subagentFinalAnswerPart(result)?.text;
  if (result.status !== "aborted" && report)
    yield* projectTodoUpdates.offer({
      sessionId: handle.parentSessionId,
      ...(handle.projectPath ? { projectPath: handle.projectPath } : null),
      subagent: { parentSessionId: handle.parentSessionId, handleId },
      text: result.status === "complete" ? report : `Worker ${result.status}: ${report}`,
    });
  if (shouldNotify) yield* deliverCompletion(handleId);
});

export const deliverCompletion = Effect.fn("Subagents.deliverCompletion")(function* (
  handleId: SubagentHandleId,
) {
  const handle = yield* requireHandleById(handleId);
  if (!handle.result || handle.completionDisposition !== "notifying") return;
  const original = subagentFinalAnswerPart(handle.result);
  const answer = original?.text;
  if (handle.recovery.continuation === "none") {
    const storage = yield* SessionFamilyStorage;
    yield* storage
      .withNoticeDelivery(
        storage.deferReferenceNotice({
          id: handle.recovery.completionId,
          recipientSessionId: handle.parentSessionId,
          source: {
            kind: "subagent",
            handleId: handle.handleId,
            sessionId: handle.recovery.privateSessionId,
            task: handle.task,
            status: handle.result.status,
            ...(original ? { messageId: original.entryId ?? original.id } : null),
          },
          text:
            handle.result.status === "complete"
              ? answer || "Subagent completed without a final report."
              : `Subagent ${handle.result.status}: ${handle.result.error || answer || "No final report was produced."}`,
        }),
      )
      .pipe(asError("completion"));
  } else {
    const delivered = handle.parentPiHandle
      ? handle.parentPiHandle
          .notifySubagentCompletion(
            parentResult(handle, handle.result),
            handle.recovery.completionId,
          )
          .pipe(asError("completion"))
      : Effect.void;
    yield* delivered;
  }
  // For continuation:none, notified means the durable reporting inbox owns the handoff,
  // not that the parent model (or the user) has received or handled it.
  yield* mutateHandle(handleId, (current) =>
    current.completionDisposition === "notifying" &&
    current.recovery.completionId === handle.recovery.completionId
      ? { ...current, completionDisposition: "notified" }
      : current,
  );
  yield* checkpoint(handleId);
});

export const failHandle = Effect.fn("Subagents.failHandle")(function* (
  handleId: SubagentHandleId,
  cause: Cause.Cause<unknown>,
) {
  const coordinator = yield* SubagentCoordinator;
  if (yield* Ref.get(coordinator.shuttingDown)) return;
  const handle = yield* requireHandleById(handleId).pipe(
    Effect.catchTag("SubagentError", () => Effect.succeed(undefined)),
  );
  if (!handle || handle.result) return;
  const aborted = Cause.hasInterrupts(cause) || handle.status === "aborted";
  const failure = Cause.findErrorOption(cause);
  const message =
    Option.isSome(failure) && failure.value instanceof SubagentError
      ? failure.value.message
      : Cause.pretty(cause);
  const result: SubagentResult = {
    handleId: handle.handleId,
    task: handle.task,
    status: aborted ? "aborted" : "error",
    resolvedModel: handle.resolvedModel,
    fastMode: handle.fastMode,
    streaming: false,
    parts: handle.parts,
    error: boundedError(aborted ? "Subagent aborted" : message),
  };
  if (handle.projectPath) Object.assign(result, { projectPath: handle.projectPath });
  if (!aborted && !handle.piHandle) Object.assign(result, { failurePhase: "start" });
  yield* completeHandle(handleId, result);
});
