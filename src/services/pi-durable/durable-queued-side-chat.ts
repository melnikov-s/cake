import { randomUUID } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  GenerationTask,
  InboxDoc,
  LiveDoc,
  UserEntry,
  type Conversation,
  type Harness,
  type Storage,
} from "@earendil-works/pi-durable";
import {
  DURABLE_SIDE_CHAT_NOTE,
  durableQueuedParts,
  markDurableInputSteering,
} from "./durable-input-presentation";

/** One mutation line with the parent's inbox boundary: either it consumes the
 * input, or this transaction starts it in the prepared native fork, never both.
 * Failure rolls back placement, settlement, and removal together. */
export async function transferDurableQueuedToSideChat(options: {
  harness: Harness;
  storage: Storage;
  source: Conversation;
  target: Conversation;
  partId: string;
  parentSessionId: string;
  targetSessionId: string;
  todoContext?: string;
}) {
  const { harness, storage, source, target, partId } = options;
  const items = (await harness.snapshot(InboxDoc, source.id, BACKGROUND_CONTEXT))?.items ?? [];
  const candidates = await Promise.all(
    items.map(async (item) => ({
      item,
      requestId:
        (await storage.submission(item.id, BACKGROUND_CONTEXT))?.requestId ?? String(item.id),
    })),
  );
  const selected = candidates.find(
    ({ requestId }) => partId === `queued-${requestId}` || partId === requestId,
  );
  if (!selected) throw new Error("That queued message no longer exists");
  const requestId = randomUUID();
  await source.commit(async (tx) => {
    const inbox = await tx.doc(InboxDoc, source.id);
    const index = inbox.items.findIndex((item) => item.id === selected.item.id);
    const item = inbox.items[index];
    if (!item || item.mode === "write") throw new Error("That message was already consumed");
    const row = durableQueuedParts(item, selected.requestId).find(
      (part) => part.id === `queued-${selected.requestId}`,
    );
    if (
      !row ||
      row.kind !== "text" ||
      row.queuedInput?.internal ||
      row.crossSession ||
      row.subagentReport ||
      row.scheduled ||
      row.agentSource
    )
      throw new Error("Only queued user messages can be sent to a side chat");
    const live = await tx.doc(LiveDoc, target.id);
    if (live.run || (await tx.doc(InboxDoc, target.id)).items.length)
      throw new Error("The new side chat is already busy");
    // Keep the complete encoded payload: vaulted references, annotations,
    // Markdown, response/presentation reminders and image blocks.
    const blocks =
      typeof item.content === "string"
        ? [{ type: "text" as const, text: item.content }]
        : item.content.map((block) => ({ ...block }));
    const content = blocks.map((block) =>
      block.type === "text"
        ? { ...block, text: markDurableInputSteering(block.text, false) }
        : block,
    );
    content.push({
      type: "text",
      text: `${DURABLE_SIDE_CHAT_NOTE}\nYour parent/main conversation address is ${options.parentSessionId}. Your own messaging identity is ${options.targetSessionId}. Use cake sessions.send with input { sessionId: "parent", text: "..." } to message the parent.\n${options.todoContext ?? ""}`,
    });
    const entry = await tx.appendEntry(UserEntry, target.id, {
      model: [{ role: "user", content, timestamp: Date.now() }],
    });
    const submission = await tx.createSubmission({
      conversationId: target.id,
      requestId,
      type: "input",
      status: "placed",
      entry: entry.id,
    });
    live.run = {
      taskId: await tx.createTask(
        GenerationTask,
        {},
        {
          ownership: { kind: "conversation" },
          conversationId: target.id,
        },
      ),
      inputs: [submission.id],
    };
    tx.settleSubmission(item.id, {
      status: "unanswered",
      reason: "aborted",
      detail: { sentToSideChat: options.targetSessionId },
    });
    inbox.items.splice(index, 1);
  }, BACKGROUND_CONTEXT);
  harness.resume();
  return requestId;
}
