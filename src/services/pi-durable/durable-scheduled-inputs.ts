import { defineDoc, LiveDoc, type Conversation, type Storage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { parseScheduledMessage } from "../../contracts/conversations/scheduled-message-envelope";
import type { ScheduledInputReceipt } from "../../contracts/scheduled-messages/scheduled-input-receipt";
import { durableQueuedText } from "./durable-input-presentation";

/** One latest consumption receipt per schedule, not a transcript or an admission log. */
const ScheduledInputsDoc = defineDoc<{
  receipts: Record<string, { turnId: string; sendAt: string; consumedAt: number }>;
}>({
  kind: "cake.scheduled-input-consumption",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "latest",
  fork: "initial",
  initial: () => ({ receipts: {} }),
});

/** Called at Pi's generation boundary, after safe-boundary inbox consumption and
 * request preparation. Merely placing an input in originals does not call this. */
export async function acknowledgeScheduledInputs(
  conversation: Conversation,
  storage: Storage,
  consumedAt: number,
) {
  await conversation.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, conversation.id);
    for (const id of live.run?.inputs ?? []) {
      const submission = await storage.submission(id, BACKGROUND_CONTEXT);
      if (submission?.type !== "input" || submission.status !== "placed" || !submission.requestId)
        continue;
      const entry = await tx.entry(submission.entry);
      for (const message of entry?.model ?? []) {
        if (message.role !== "user") continue;
        const origin = parseScheduledMessage(durableQueuedText(message.content))?.origin;
        if (!origin) continue;
        const doc = await tx.doc(ScheduledInputsDoc, conversation.id);
        const previous = doc.receipts[origin.id];
        // Runs can retain multiple steered inputs. Re-observing an older input must
        // neither replace the latest occurrence nor slide its consumption timestamp.
        if (!previous || origin.sendAt > previous.sendAt)
          doc.receipts[origin.id] = {
            turnId: submission.requestId,
            sendAt: origin.sendAt,
            consumedAt,
          };
      }
    }
  }, BACKGROUND_CONTEXT);
}

export async function scheduledInputReceipt(
  conversation: Conversation,
  turnId: string,
): Promise<ScheduledInputReceipt | undefined> {
  return conversation.commit(async (tx) => {
    const doc = await tx.doc(ScheduledInputsDoc, conversation.id);
    const receipt = Object.values(doc.receipts).find((item) => item.turnId === turnId);
    if (receipt) return { status: "consumed", consumedAt: receipt.consumedAt };
    const submission = await tx.submissionByRequest(conversation.id, turnId);
    if (!submission) return undefined;
    if (submission.status === "unanswered")
      return submission.reason === "aborted"
        ? { status: "canceled" }
        : { status: "failed", message: submission.reason };
    // Even a placed transcript entry is not a consumption acknowledgement.
    return { status: "pending" };
  }, BACKGROUND_CONTEXT);
}
