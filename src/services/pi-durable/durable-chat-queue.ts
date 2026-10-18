import {
  durableQueuedDisplayText,
  durableQueuedText,
  markDurableInputSteering,
} from "./durable-input-presentation";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import type { CakeSessionRuntime } from "../pi/runtime/cake-session-runtime";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  GenerationTask,
  InboxDoc,
  LiveDoc,
  UserEntry,
  type Harness,
  type Conversation,
  type SubmissionId,
  type InboxItem,
  type Storage,
} from "@earendil-works/pi-durable";

type QueueOperations = Pick<
  CakeSessionRuntime,
  | "listQueuedMessages"
  | "pendingMessages"
  | "reorderPendingMessage"
  | "clearQueue"
  | "cancelSteering"
  | "removeQueuedMessage"
  | "steerQueuedMessage"
  | "sendQueuedMessageNow"
>;

/** Private Durable adapter policy, bound to exactly one SDK conversation. This
 * owns no lifetime, subscriptions, admission or settlement bookkeeping. */
export function createDurableConversationQueue(options: {
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly storage: Storage;
  readonly kind: "root" | "side-chat";
  readonly executingTurnIds: () => readonly string[];
}) {
  const { harness, conversation, storage } = options;
  const inbox = async () =>
    (await harness.snapshot(InboxDoc, conversation.id, BACKGROUND_CONTEXT))?.items ?? [];
  const requestId = async (item: InboxItem) =>
    (await storage.submission(item.id, BACKGROUND_CONTEXT))?.requestId ?? String(item.id);
  const itemFor = async (partId: string) => {
    for (const item of await inbox()) {
      const id = await requestId(item);
      if (partId === `queued-${id}` || partId === id) return item;
    }
    throw new Error("That queued message no longer exists");
  };
  const queued = async () => {
    const items = await inbox();
    const lane = (mode: InboxItem["mode"]) =>
      items
        .filter((item): item is Extract<InboxItem, { content: unknown }> => item.mode === mode)
        .map((item) => durableQueuedDisplayText(item.content));
    return { steering: lane("steer"), followUp: lane("followUp") };
  };
  const operations: QueueOperations = {
    listQueuedMessages: queued,
    async pendingMessages() {
      const items = (await inbox()).filter((item) => item.mode !== "write");
      return {
        items: await Promise.all(
          items.map(async (item, index) => {
            const id = await requestId(item);
            const text = durableQueuedText(item.content);
            return {
              itemId: id,
              partId: `queued-${id}`,
              lane: item.mode === "steer" ? ("steering" as const) : ("follow-up" as const),
              position: items.slice(0, index + 1).filter((other) => other.mode === item.mode)
                .length,
              state: "queued" as const,
              text,
              crossSession: parseCrossSessionMessage(text)?.metadata,
            };
          }),
        ),
      };
    },
    async reorderPendingMessage(input) {
      const item = await itemFor(input.itemId);
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(InboxDoc, conversation.id);
        const index = doc.items.findIndex((entry) => entry.id === item.id);
        if (index < 0) throw new Error("That message was already consumed");
        const moved = doc.items[index];
        if (!moved) throw new Error("That message was already consumed");
        doc.items.splice(index, 1);
        const positions = doc.items.flatMap((entry, position) =>
          entry.mode === item.mode ? [position] : [],
        );
        doc.items.splice(positions[input.position - 1] ?? doc.items.length, 0, moved);
      }, BACKGROUND_CONTEXT);
      return operations.pendingMessages();
    },
    async clearQueue() {
      for (const item of await inbox())
        if (item.mode !== "write")
          await harness.abortSubmission(item.id, BACKGROUND_CONTEXT, conversation.id);
      return queued();
    },
    async cancelSteering() {
      for (const item of await inbox())
        if (item.mode === "steer")
          await harness.abortSubmission(item.id, BACKGROUND_CONTEXT, conversation.id);
      return queued();
    },
    async removeQueuedMessage(partId) {
      const item = await itemFor(partId);
      const result = await harness.abortSubmission(item.id, BACKGROUND_CONTEXT, conversation.id);
      if (result === "already_placed") throw new Error("That message was already consumed");
      return queued();
    },
    async steerQueuedMessage(partId) {
      const item = await itemFor(partId);
      await conversation.commit(async (tx) => {
        const doc = await tx.doc(InboxDoc, conversation.id);
        const queuedItem = doc.items.find((entry) => entry.id === item.id);
        if (!queuedItem || queuedItem.mode === "write")
          throw new Error("That message was already consumed");
        if (queuedItem.mode === "steer") return;
        queuedItem.mode = "steer";
        if (typeof queuedItem.content === "string")
          queuedItem.content = markDurableInputSteering(queuedItem.content);
        else {
          for (const block of queuedItem.content) {
            if (block.type !== "text") continue;
            block.text = markDurableInputSteering(block.text);
            // Side chats carry model-only orientation after the first text block.
            if (options.kind === "side-chat") break;
          }
        }
        // Promotion inserts at the steering tail, not its old follow-up position.
        // Finish draft edits before detaching the item from the transaction array.
        const [promoted] = doc.items.splice(doc.items.indexOf(queuedItem), 1);
        const tail = doc.items.findLastIndex((entry) => entry.mode === "steer");
        if (promoted) doc.items.splice(tail + 1, 0, promoted);
      }, BACKGROUND_CONTEXT);
      return queued();
    },
    async sendQueuedMessageNow(partId) {
      const item = partId
        ? await itemFor(partId)
        : (await inbox()).find((entry) => entry.mode !== "write");
      if (!item || item.mode === "write") throw new Error("No queued message to send");
      const abortedTurnIds = [...options.executingTurnIds()];
      await startDurableQueuedInput(harness, conversation, item.id);
      return { queued: await queued(), abortedTurnIds };
    },
  };
  return { inbox, requestId, operations };
}

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
async function startDurableQueuedInput(harness: Harness, root: Conversation, id: SubmissionId) {
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
