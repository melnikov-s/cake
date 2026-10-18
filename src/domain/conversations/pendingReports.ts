import { Effect } from "effect";
import {
  agentListLabel,
  agentListPage,
  type AgentListInput,
} from "../../contracts/agent/agent-list-data";
import type {
  PendingReportAcknowledge,
  PendingReportRead,
} from "../../contracts/conversations/pending-report";
import type { UiPart } from "../../contracts/conversations/session-contract";
import { SessionChatError } from "../../contracts/conversations/conversation-data";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
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
        (!query ||
          `${item.id} ${item.source?.task ?? ""} ${item.source?.handleId ?? ""}`
            .toLowerCase()
            .includes(query)),
    )
    .map((item) => ({
      id: item.id,
      state: "pending",
      admissions: item.admissions ?? 0,
      source: item.source ? { ...item.source, task: agentListLabel(item.source.task) } : undefined,
    }));
  return agentListPage(items, input);
});

export const read = Effect.fn("PendingReports.read")(function* (
  sessionId: string,
  input: PendingReportRead,
) {
  const item = ((yield* (yield* SessionFamilyStorage).state()).deferredReferences ?? []).find(
    (item) => item.id === input.id && item.recipientSessionId === sessionId,
  );
  if (!item)
    return yield* new SessionChatError({
      operation: "reports.read",
      message: "No pending report with that ID in this conversation",
    });
  const offset = input.offset ?? 0;
  const text = item.text.slice(offset, offset + (input.limit ?? 4000));
  return {
    id: item.id,
    state: "pending",
    source: item.source,
    text,
    offset,
    nextOffset: offset + text.length < item.text.length ? offset + text.length : null,
  };
});

/** Only persisted visible assistant text after the latest consumed input can anchor an attestation. */
export function communicationEvidence(
  parts: readonly UiPart[],
  communicatedText: string,
): string | undefined {
  const lastInput = parts.findLastIndex(
    (part) => part.kind === "text" && part.role === "user" && !part.deliveryState,
  );
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

/** Explicit agent attestation, anchored to already-visible Pi text, never inferred from turn success. */
export const acknowledge = Effect.fn("PendingReports.acknowledge")(function* (
  sessionId: string,
  input: PendingReportAcknowledge,
) {
  const storage = yield* SessionFamilyStorage;
  return yield* storage.withNoticeDelivery(
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
      const snapshot = yield* (yield* (yield* CakeSessionRuntimes).acquireSession(
        sessionId,
      )).snapshot();
      // Do not accept an old reply, queued input, reasoning, context pill or a future final answer.
      const evidence = communicationEvidence(snapshot.parts, input.communicatedText);
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
