import { Effect } from "effect";
import {
  encodeCrossSessionMessage,
  parseCrossSessionMessage,
} from "../../contracts/conversations/cross-session-message";
import type { Attachment } from "../../ipc/session-contract";
import { TaskInputStorage } from "../../services/storage/TaskInputStorage";
import type { SessionChatPromptInput } from "../../ipc/conversation-data";

/** Messages/assignments/forks can carry derived content even without original references. */
export const inheritTaskInputProtection = Effect.fn("Conversations.inheritTaskInputProtection")(
  function* (sourceSessionId: string, recipientSessionId: string) {
    const inputs = yield* TaskInputStorage;
    if (yield* inputs.isRecipient(sourceSessionId))
      yield* inputs.protectRecipient(recipientSessionId);
  },
);

/** Without linked responses, protected workers may return status, never report content. */
export const prepareCoordinatorMessage = Effect.fn("Conversations.prepareCoordinatorMessage")(
  function* (input: SessionChatPromptInput) {
    if (!input.crossSession) return input;
    const inputs = yield* TaskInputStorage;
    if (!(yield* inputs.isRecipient(input.crossSession.sender.sessionId))) return input;
    return {
      ...input,
      text: "The task session sent a response. Open the Project Session to read it.",
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
  return yield* coordinator
    ? inputs.isolate(sessionId, attachments)
    : inputs.resolve(sessionId, attachments);
});
