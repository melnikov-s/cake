import { Effect, Schema } from "effect";
import { agentListPage, type AgentListInput } from "../../contracts/agent/agent-list-data";
import {
  NOTICE_DELIVERY_MAX_FAILURES,
  NoticeDeliveryRetry,
} from "../../contracts/session-families/session-family-document";
import { SessionFamilyStorageError } from "../../contracts/storage/session-family-storage-errors";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";

/** Recovery metadata only: results remain in their original journal/transcript. */
export const list = Effect.fn("NoticeDeliveryRecovery.list")(function* (
  recipientSessionId: string,
  input: AgentListInput = {},
) {
  const document = yield* (yield* SessionFamilyStorage).state();
  const items = document.turns
    .filter(
      (turn) =>
        turn.senderSessionId === recipientSessionId &&
        turn.outcome &&
        !turn.reported &&
        turn.deliveryError,
    )
    .map((turn) => ({
      id: turn.turnId,
      sessionId: turn.sessionId,
      failures: turn.deliveryFailureCount ?? 0,
      status:
        (turn.deliveryFailureCount ?? 0) >= NOTICE_DELIVERY_MAX_FAILURES ? "paused" : "retrying",
      error: turn.deliveryError,
    }));
  const query = input.query?.toLowerCase();
  return agentListPage(
    query
      ? items.filter((item) =>
          `${item.id} ${item.sessionId} ${item.error}`.toLowerCase().includes(query),
        )
      : items,
    input,
  );
});

/** Re-arm delivery only; preserve admission IDs so accepted inputs are not replayed. */
export const retry = Effect.fn("NoticeDeliveryRecovery.retry")(function* (
  recipientSessionId: string,
  input: NoticeDeliveryRetry,
) {
  const { id } = yield* Schema.decodeUnknownEffect(NoticeDeliveryRetry)(input);
  const storage = yield* SessionFamilyStorage;
  return yield* storage.withNoticeDelivery(
    Effect.gen(function* () {
      const turn = (yield* storage.state()).turns.find(
        (turn) =>
          turn.turnId === id && turn.senderSessionId === recipientSessionId && !turn.reported,
      );
      if (!turn?.outcome || !turn.deliveryError)
        return yield* new SessionFamilyStorageError({
          operation: "retryNoticeDelivery",
          message: "No failed result delivery for this chat and ID",
        });
      yield* storage.retryNoticeDelivery(recipientSessionId, id);
      return { id, status: "queued" as const };
    }),
  );
});
