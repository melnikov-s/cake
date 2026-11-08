import {
  appendMessageReferences,
  messageReferencesInText,
} from "../../contracts/conversations/message-reference-forwarding";
import { Effect } from "effect";
import { protectedResponseNotice } from "../../contracts/conversations/reference-notification";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
} from "../../contracts/conversations/cross-session-message";
import type { Attachment } from "../../contracts/conversations/session-contract";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import {
  SessionChatError,
  type SessionChatPromptInput,
} from "../../contracts/conversations/conversation-data";
import { parseSessionLink } from "../../contracts/conversations/message-reference";

/** Messages/assignments/forks can carry derived content even without original references. */
export const inheritTaskInputProtection = Effect.fn("Conversations.inheritTaskInputProtection")(
  function* (sourceSessionId: string, recipientSessionId: string) {
    const inputs = yield* TaskInputStorage;
    if (yield* inputs.isRecipient(sourceSessionId))
      yield* inputs.protectRecipient(recipientSessionId);
  },
);

/** Protected reports remain data behind exact Pi references, never inline instructions. */
export const prepareCoordinatorMessage = Effect.fn("Conversations.prepareCoordinatorMessage")(
  function* (input: SessionChatPromptInput) {
    // Lifecycle facts have no authored response to redact or recover.
    if (!input.crossSession || input.crossSession.generatedNotice) return input;
    const inputs = yield* TaskInputStorage;
    if (!(yield* inputs.isRecipient(input.crossSession.sender.sessionId))) return input;
    const source = input.crossSession.sourceMessageRef;
    if (source && parseSessionLink(source)?.sessionId !== input.crossSession.sender.sessionId)
      return yield* new SessionChatError({
        operation: "deliver",
        message: "The response source must belong to the sending session",
      });
    const references = [
      ...new Set([...(source ? [source] : []), ...messageReferencesInText(input.text)]),
    ].slice(0, 20);
    return {
      ...input,
      text: appendMessageReferences(protectedResponseNotice, references),
      attachments: [],
      crossSession: {
        ...input.crossSession,
        sender: { ...input.crossSession.sender, title: "Task session" },
      },
    };
  },
);

/** Backend report routing keeps its correlation envelope without releasing worker content. */
export const prepareCoordinatorNotice = Effect.fn("Conversations.prepareCoordinatorNotice")(
  function* (sessionId: string, text: string) {
    const message = parseCrossSessionMessage(text);
    if (!message) return text;
    const prepared = yield* prepareCoordinatorMessage({
      sessionId,
      text: message.text,
      crossSession: message.metadata,
      attachments: [],
      renderUserMessageAsMarkdown: false,
    });
    return encodeCrossSessionMessage(prepared.text, prepared.crossSession ?? message.metadata);
  },
);

/** Kind-specific policy belongs before Pi admission, not in a coordinator instruction. */
export const prepareTaskInputs = Effect.fn("Conversations.prepareTaskInputs")(function* (
  sessionId: string,
  coordinator: boolean,
  attachments: readonly Attachment[],
) {
  if (!attachments.length) return attachments;
  const inputs = yield* TaskInputStorage;
  if (!coordinator) return yield* inputs.resolve(sessionId, attachments);
  // Annotations quote the coordinator's own transcript, so they stay inline and
  // render exactly as in Project Sessions; every other original is isolated.
  const result: Attachment[] = [];
  for (const attachment of attachments)
    result.push(
      ...(attachment.kind === "annotation"
        ? [attachment]
        : yield* inputs.isolate(sessionId, [attachment])),
    );
  return result;
});
