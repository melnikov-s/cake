import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation, type EntryId } from "@earendil-works/pi-durable";

/** Display preferences only. Originals, inbox content and model context stay SDK-owned. */
export const UserMessagePresentationDoc = defineDoc<{
  overrides: Record<string, boolean>;
}>({
  kind: "cake.user-message-presentation",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "initial",
  initial: () => ({ overrides: {} }),
});

export async function setDurableUserMessageMarkdown(
  conversation: Conversation,
  entryId: string,
  markdown: boolean,
): Promise<void> {
  const id = Number(entryId);
  if (!Number.isSafeInteger(id) || id < 0)
    throw new Error("The user message is not in the active conversation");
  await conversation.commit(async (tx) => {
    // SAFETY: Durable entry IDs are nonnegative safe integers, checked above.
    const entry = await tx.entry(id as EntryId);
    if (
      entry?.conversationId !== conversation.id ||
      entry.kind !== "pi.user" ||
      !entry.model?.some((message) => message.role === "user")
    )
      throw new Error("The user message is not in the active conversation");
    const presentation = await tx.doc(UserMessagePresentationDoc, conversation.id);
    presentation.overrides[String(id)] = markdown;
  }, BACKGROUND_CONTEXT);
}
