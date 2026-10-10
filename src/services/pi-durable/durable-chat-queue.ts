import { markDurableInputSteering } from "./durable-input-presentation";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  GenerationTask,
  InboxDoc,
  LiveDoc,
  UserEntry,
  type Harness,
  type Conversation,
  type SubmissionId,
} from "@earendil-works/pi-durable";

/** Interrupt only the run present at admission. Unlike Conversation.abort(), this
 * keeps the durable inbox, matching Cake's Stop/queued-message contract. */
export async function abortDurableActiveTurn(harness: Harness, root: Conversation) {
  let live = await harness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT);
  const input = live?.run?.inputs[0];
  if (input === undefined) return;
  do {
    if (!live?.run || live.run.inputs[0] !== input) return;
    const task = live.run.taskId;
    await harness.abortTask(task, BACKGROUND_CONTEXT);
    await harness.waitForTask(task, BACKGROUND_CONTEXT);
    live = await harness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT);
  } while (live?.run?.inputs[0] === input);
}

/** Place exactly the selected existing submission in one SDK transaction. Its
 * request/turn identity and every other queued input survive; no cancel-and-copy gap.
 * If another run or boundary wins, reject without withdrawing the selected input. */
export async function startDurableQueuedInput(
  harness: Harness,
  root: Conversation,
  id: SubmissionId,
) {
  await abortDurableActiveTurn(harness, root);
  await root.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, root.id);
    const inbox = await tx.doc(InboxDoc, root.id);
    const index = inbox.items.findIndex((item) => item.id === id);
    const item = inbox.items[index];
    if (!item || item.mode === "write") throw new Error("That message was already consumed");
    if (live.run)
      throw new Error("Another run started before send-now; the queued message was retained");
    const entry = await tx.appendEntry(UserEntry, root.id, {
      model: [
        {
          role: "user",
          content:
            typeof item.content === "string"
              ? markDurableInputSteering(item.content, false)
              : item.content.map((block) =>
                  block.type === "text"
                    ? { ...block, text: markDurableInputSteering(block.text, false) }
                    : { ...block },
                ),
          timestamp: Date.now(),
        },
      ],
    });
    tx.placeSubmission(id, entry.id);
    inbox.items.splice(index, 1);
    live.run = {
      taskId: await tx.createTask(
        GenerationTask,
        {},
        { ownership: { kind: "conversation" }, conversationId: root.id },
      ),
      inputs: [id],
    };
  }, BACKGROUND_CONTEXT);
  harness.resume();
}
