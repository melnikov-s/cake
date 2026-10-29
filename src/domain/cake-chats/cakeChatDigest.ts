import { Effect } from "effect";
import { CAKE_CHAT_SESSION_ID } from "../../contracts/cake-chats/cake-chat-identity";
import {
  addSessionDigestReminder,
  formatSessionDigestReminder,
} from "../../contracts/cake-chats/session-digest-reminder";
import { sessionReference } from "../../contracts/project-sessions/session-reference";
import type { CakeSessionHandle } from "../../services/pi/CakeSessionRuntimes";
import { SessionFamilyStorage } from "../../services/storage/SessionFamilyStorage";

/**
 * The quiet session inbox rides along as one Cake-owned reminder without changing delivery.
 * The caller removes `digestIds` only after admission, so a failed send keeps the items.
 */
export const prepareUserMessage = Effect.fn("CakeChatDigest.prepareUserMessage")(function* (
  handle: CakeSessionHandle,
  text: string,
) {
  const snapshot = yield* handle.snapshot();
  const storage = yield* SessionFamilyStorage;
  const admitted = handle.admittedDigestIds ? yield* handle.admittedDigestIds() : [];
  if (admitted.length) yield* storage.removeDigest(admitted);
  const state = yield* storage.state();
  const items = (state.coordinatorDigest ?? [])
    .filter((item) => (item.coordinatorSessionId ?? CAKE_CHAT_SESSION_ID) === snapshot.sessionId)
    .slice(0, 20);
  const knownIds = [
    ...new Set([
      ...items.map((item) => item.sessionId),
      ...state.spawnedSessions.map((spawn) => spawn.sessionId),
    ]),
  ];
  const reminder = formatSessionDigestReminder({
    lines: items.map((item) => ({
      reference: sessionReference(item.sessionId, knownIds),
      sessionId: item.sessionId,
      title: item.title,
      status: item.status,
      summary: item.summary,
      resultMessageRef: item.resultMessageRef,
      references: state.completionInbox?.find((entry) => entry.id === item.id)?.references,
      kind: state.completionInbox?.find((entry) => entry.id === item.id)?.kind,
      decisions: state.completionInbox?.find((entry) => entry.id === item.id)?.decisions,
    })),
    receiptIds: items.map((item) => item.id),
  });
  return {
    text: addSessionDigestReminder(text, reminder),
    digestIds: items.map((item) => item.id),
  };
});
