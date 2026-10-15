import { Effect } from "effect";
import type { MessageMetadata } from "../../contracts/conversations/message-reference";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";

/** A selected exact Pi message can share only the input IDs its source is allowed to share. */
export const grantMessageAttachments = Effect.fn("MessageReferences.grantAttachments")(function* (
  recipientSessionId: string,
  message: MessageMetadata,
) {
  if (!message.inputRefs.length || message.sessionId === recipientSessionId) return;
  const inputs = yield* TaskInputStorage;
  const grants = yield* inputs.authorizeForward(
    message.sessionId,
    message.inputRefs.map((input) => input.id),
    recipientSessionId,
  );
  yield* inputs.grant(recipientSessionId, grants);
});
