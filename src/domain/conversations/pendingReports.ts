import { Clock, Effect } from "effect";
import {
  agentListLabel,
  agentListPage,
  type AgentListInput,
} from "../../contracts/agent/agent-list-data";
import {
  pendingReportRef,
  type PendingReportAcknowledge,
  type PendingReportRead,
} from "../../contracts/conversations/pending-report";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import { CakeSessionRuntimes, type CakeSessionHandle } from "../../services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";

export const list = Effect.fn("PendingReports.list")(function* (
  sessionId: string,
  input: AgentListInput,
) {
  const query = input.query?.toLowerCase();
  const items = ((yield* (yield* SessionFamilyStorage).state()).deferredReferences ?? [])
    .filter(
      (item) =>
        item.recipientSessionId === sessionId &&
        !item.attentionTodoId &&
        (!query ||
          `${item.id} ${item.source?.task ?? ""} ${item.source?.handleId ?? ""}`
            .toLowerCase()
            .includes(query)),
    )
    .map((item) => ({
      id: item.id,
      state: "pending",
      ref: pendingReportRef(item),
      admissions: item.admissions ?? 0,
      source: item.source ? { ...item.source, task: agentListLabel(item.source.task) } : undefined,
    }));
  return agentListPage(items, input);
});

export const read = Effect.fn("PendingReports.read")(function* (
  sessionId: string,
  input: PendingReportRead,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const state = yield* (yield* SessionFamilyStorage).state();
  const loadedAt = yield* Clock.currentTimeMillis;
  const item = (state.deferredReferences ?? []).find(
    (item) =>
      item.id === input.id && item.recipientSessionId === sessionId && !item.attentionTodoId,
  );
  if (!item)
    return yield* new SessionChatError({
      operation: "reports.read",
      message: "No pending report with that ID in this conversation",
    });
  const offset = input.offset ?? 0;
  const text = item.text.slice(offset, offset + (input.limit ?? 4000));
  // Numeric, request-local evidence only; no report text, IDs or provenance in logs.
  yield* Effect.logDebug("Pending report read timings", {
    storageMs: loadedAt - startedAt,
    sliceMs: (yield* Clock.currentTimeMillis) - loadedAt,
    returnedCharacters: text.length,
  });
  return {
    id: item.id,
    state: "pending",
    source: item.source,
    ref: pendingReportRef(item),
    text,
    totalChars: item.text.length,
    offset,
    nextOffset: offset + text.length < item.text.length ? offset + text.length : null,
  };
});

/** Visible FYIs can sit after a reply while their transport is still queued.
 * Only a Pi-backed user transport, not its sender-authored presentation rows, is a boundary.
 */
const isConsumedInput = (part: UiPart) =>
  part.kind === "text" && part.role === "user" && part.entryId !== undefined && !part.deliveryState;

/** Only persisted visible assistant text after the latest consumed input can anchor an attestation. */
export function communicationEvidence(
  parts: readonly UiPart[],
  communicatedText: string,
): string | undefined {
  const lastInput = parts.findLastIndex(isConsumedInput);
  if (lastInput < 0 || !communicatedText.trim()) return undefined;
  return parts
    .slice(lastInput + 1)
    .findLast(
      (part) =>
        part.kind === "text" &&
        part.role === "assistant" &&
        part.status === "complete" &&
        part.entryId !== undefined &&
        part.text.trim().length > 0 &&
        part.text.includes(communicatedText.trim()),
    )?.id;
}

/** Resolve the current input boundary even when Durable's bounded snapshot starts mid-turn.
 * Read only Pi-owned history, stopping at the first consumed input; never reuse an older reply.
 */
export const readCommunicationEvidence = Effect.fn("PendingReports.readCommunicationEvidence")(
  function* (handle: Pick<CakeSessionHandle, "snapshot" | "history">, communicatedText: string) {
    const snapshot = yield* handle.snapshot();
    let parts = snapshot.parts;
    let cursor = snapshot.historyCursor;
    const visited = new Set<string>();
    while (!parts.some(isConsumedInput) && cursor !== undefined && handle.history) {
      if (visited.has(cursor))
        return yield* new SessionChatError({
          operation: "reports.acknowledge",
          message: "Earlier report evidence history did not advance. Retry acknowledgment.",
        });
      visited.add(cursor);
      const page = yield* handle.history(cursor);
      parts = [...page.parts, ...parts];
      cursor = page.cursor;
    }
    return communicationEvidence(parts, communicatedText);
  },
);

/** Explicit agent attestation, anchored to already-visible Pi text, never inferred from turn success. */
export const acknowledge = Effect.fn("PendingReports.acknowledge")(function* (
  sessionId: string,
  input: PendingReportAcknowledge,
) {
  const storage = yield* SessionFamilyStorage;
  return yield* storage.withNoticeDelivery(
    sessionId,
    "reports.acknowledge",
    Effect.gen(function* () {
      const state = yield* storage.state();
      const pending = (state.deferredReferences ?? []).filter(
        (item) => item.recipientSessionId === sessionId && input.ids.includes(item.id),
      );
      const handled = (state.handledReports ?? []).filter(
        (item) => item.recipientSessionId === sessionId && input.ids.includes(item.id),
      );
      if (pending.length + handled.length !== input.ids.length)
        return yield* new SessionChatError({
          operation: "reports.acknowledge",
          message: "Unknown report ID in this conversation",
        });
      if (!pending.length)
        return { acknowledged: input.ids, alreadyHandled: true, receipts: handled };
      const handle = yield* (yield* CakeSessionRuntimes).acquireSession(sessionId);
      // Do not accept an old reply, queued input, reasoning, context pill or a future final answer.
      const evidence = yield* readCommunicationEvidence(handle, input.communicatedText);
      if (!evidence)
        return yield* new SessionChatError({
          operation: "reports.acknowledge",
          message:
            "Emit the user-facing report (or the user's dismissal) as assistant text first, then acknowledge using its exact text. Intake, tools and planned replies are not evidence.",
        });
      yield* storage.acknowledgeReports(
        pending.map((item) => ({
          id: item.id,
          recipientSessionId: sessionId,
          assistantPartId: evidence,
          disposition: input.disposition,
        })),
      );
      return { acknowledged: input.ids, assistantPartId: evidence, disposition: input.disposition };
    }),
  );
});
