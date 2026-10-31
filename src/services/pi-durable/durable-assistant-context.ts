import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Conversation } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import {
  AssistantContext,
  sameAssistantContext,
} from "../../contracts/cake-chats/assistant-context";

export const ASSISTANT_CONTEXT_ENTRY = "cake.assistant-context/v1";
const ContextDoc = defineDoc<{ context: AssistantContext | null }>({
  kind: "cake.assistant-context",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  checkpointWhen: () => false,
  initial: () => ({ context: null }),
});

/** Passive original: changes orientation without submitting, steering or waking an agent. */
export async function transitionAssistantContext(
  root: Conversation,
  input: AssistantContext | null,
) {
  const next = await Schema.decodeUnknownPromise(Schema.NullOr(AssistantContext))(input);
  await root.commit(async (tx) => {
    const state = await tx.doc(ContextDoc, root.id);
    if (sameAssistantContext(state.context, next)) return;
    const lines = [
      ...(state.context ? ["Left context " + JSON.stringify(state.context) + "."] : []),
      ...(next ? ["Entered context " + JSON.stringify(next) + "."] : []),
    ];
    state.context = next;
    await tx.appendEntry(root.id, {
      kind: ASSISTANT_CONTEXT_ENTRY,
      data: { text: lines.join("\n") },
      model: [
        {
          role: "user",
          timestamp: Date.now(),
          content:
            "Companion orientation metadata (not a user request; no reply needed).\n" +
            lines.join("\n"),
        },
      ],
    });
  }, BACKGROUND_CONTEXT);
}
