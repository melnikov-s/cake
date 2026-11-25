import { parseScheduledMessage } from "../../contracts/conversations/scheduled-message-envelope";
import {
  durableQueuedDisplayText,
  durableQueuedText,
  markDurableInputSteering,
  updateDurableInputText,
} from "./durable-input-presentation";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import type { CakeSessionRuntime } from "../pi/runtime/cake-session-runtime";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord/json";
import {
  GenerationTask,
  InboxDoc,
  LiveDoc,
  UserEntry,
  defineDoc,
  type Tx,
  type InputSubmissionDraft,
  type Harness,
  type Conversation,
  type ConversationId,
  type SubmissionId,
  type InboxItem,
  type Storage,
} from "@earendil-works/pi-durable";

type QueueOperations = Pick<
  CakeSessionRuntime,
  | "setQueuePaused"
  | "listQueuedMessages"
  | "pendingMessages"
  | "reorderPendingMessage"
  | "clearQueue"
  | "cancelSteering"
  | "updateQueuedMessage"
  | "removeQueuedMessage"
  | "steerQueuedMessage"
  | "sendQueuedMessageNow"
>;

type HeldInput = Exclude<InboxItem, { mode: "write" }>;

function copyQueueValue<
  T extends InboxItem[] | HeldInput["content"] | NonNullable<HeldInput["entry"]>,
>(value: T): T {
  // SAFETY: These typed SDK inputs and drafts are JSON-shaped; copying preserves
  // their fields and IDs, discarding only explicitly undefined optional fields.
  return copyJson(value, { omitUndefinedProperties: true }) as T;
}

// SDK run boundaries consume pi.inbox. Hold the same SDK receipts out of that
// inbox on the same conversation transaction line. No abort, copy-submit, or retry.
export const HeldQueueDoc = defineDoc<{ paused: boolean; items: HeldInput[] }>({
  kind: "cake.held-queue",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ paused: false, items: [] }),
  checkpointWhen: (state) => !state.paused && state.items.length === 0,
});

/** Durable queue policy bound to exactly one SDK conversation. */
export function createDurableConversationQueue(options: {
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly storage: Storage;
  readonly kind: "root" | "side-chat";
  readonly executingTurnIds: () => readonly string[];
  readonly beforeSendNow?: () => Promise<() => void>;
  readonly onReport?: (error: unknown) => void;
}) {
  const { harness, conversation, storage } = options;
  const { id: conversationId } = conversation;
  const queueState = async (tx: Tx) => ({
    held: await tx.doc(HeldQueueDoc, conversationId),
    native: await tx.doc(InboxDoc, conversationId),
  });
  const read = async (tx: Tx) => {
    const { held, native } = await queueState(tx);
    return { paused: held.paused, items: [...held.items, ...native.items] };
  };
  // Detach the typed SDK drafts before the transaction closes.
  const snapshot = () =>
    conversation.commit(async (tx) => {
      const { paused, items } = await read(tx);
      return { paused, items: copyQueueValue(items) };
    }, BACKGROUND_CONTEXT);
  const inbox = async () => (await snapshot()).items;

  const placeNext = async (tx: Tx) => {
    const held = await tx.doc(HeldQueueDoc, conversationId);
    const item = held.items[0];
    if (held.paused || !item) return false;
    const live = await tx.doc(LiveDoc, conversationId);
    if (live.run) return false;
    await startDurableInput(tx, conversationId, live, item);
    held.items.splice(0, 1);
    return true;
  };
  let observing = false;
  const kick = () => {
    if (!observing) return;
    void conversation
      .commit((tx) => observing && placeNext(tx), BACKGROUND_CONTEXT)
      .then((started) => {
        if (observing && started) harness.resume();
      })
      .catch(options.onReport ?? console.error);
  };
  const observe = () => {
    observing = true;
    const commits = harness.observeCommits({
      advance(publication) {
        if (
          publication.changes.some(
            (change) =>
              change.type === "document" &&
              change.kind === "change" &&
              change.conversationId === conversationId &&
              change.record.kind === "pi.live" &&
              change.value.run === undefined,
          )
        )
          queueMicrotask(kick);
      },
      end() {
        observing = false;
      },
    });
    kick(); // Reopen may need to finish a drain admitted before the last close.
    return () => {
      observing = false;
      commits.detach();
    };
  };
  const submit = async (
    draft: InputSubmissionDraft,
    resumeQueue = false,
    assertCurrent?: () => void,
  ) => {
    const result = await conversation.commit(async (tx) => {
      const { held } = await queueState(tx);
      assertCurrent?.();
      if (!held.paused && !held.items.length)
        return { id: await conversation.submit(tx, draft), resumed: false };
      if (draft.requestId !== undefined) {
        const existing = await tx.submissionByRequest(conversationId, draft.requestId);
        if (existing) return { id: existing.id, resumed: false };
      }
      const priority = held.paused && resumeQueue;
      const { id } = await tx.createSubmission({
        conversationId,
        requestId: draft.requestId,
        type: "input",
        status: "queued",
        notify: draft.notify,
      });
      const item: HeldInput = {
        id,
        mode: !priority && draft.whenBusy === "steer" ? "steer" : "followUp",
        content: copyQueueValue(draft.content),
        ...(draft.entry ? { entry: copyQueueValue(draft.entry) } : null),
        ...(draft.onAbort === "keep" ? { onAbort: "keep" } : null),
      };
      if (priority) {
        held.items.unshift(item);
        held.paused = false;
      } else held.items.push(item);
      await placeNext(tx);
      return { id, resumed: !held.paused };
    }, BACKGROUND_CONTEXT);
    if (result.resumed) harness.resume();
    const submission = await harness.submission(result.id, BACKGROUND_CONTEXT);
    if (!submission) throw new Error("The admitted input could not be found");
    return submission;
  };
  const withdraw = (id: SubmissionId) =>
    conversation.commit(async (tx) => {
      const submission = await tx.submission(id);
      if (submission?.conversationId !== conversationId) return "not_found";
      if (submission.status !== "queued")
        return submission.status === "placed" ? "already_placed" : "settled";
      const { held, native } = await queueState(tx);
      for (const items of [held.items, native.items]) {
        const index = items.findIndex((item) => item.id === id);
        if (index >= 0) items.splice(index, 1);
      }
      tx.settleSubmission(id, { status: "unanswered", reason: "aborted" });
      return "aborted";
    }, BACKGROUND_CONTEXT);
  const edit = async (id: SubmissionId, update: (items: InboxItem[], index: number) => void) =>
    conversation.commit(async (tx) => {
      const { held, native } = await queueState(tx);
      for (const items of [held.items, native.items]) {
        const index = items.findIndex((item) => item.id === id);
        if (index >= 0) return update(items, index);
      }
      throw new Error("That message was already consumed");
    }, BACKGROUND_CONTEXT);
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
        .filter((item): item is HeldInput => item.mode === mode)
        .map((item) => durableQueuedDisplayText(item.content));
    return { steering: lane("steer"), followUp: lane("followUp") };
  };
  const operations: QueueOperations = {
    async setQueuePaused(paused) {
      await conversation.commit(async (tx) => {
        const { held, native } = await queueState(tx);
        if (paused === held.paused) return;
        if (paused) {
          const waiting = native.items.filter((item): item is HeldInput => item.mode !== "write");
          if (!held.items.length && !waiting.length) return;
          held.items.push(...copyQueueValue(waiting));
          for (let index = native.items.length - 1; index >= 0; index--)
            if (native.items[index]?.mode !== "write") native.items.splice(index, 1);
        }
        held.paused = paused;
        if (!paused) await placeNext(tx);
      }, BACKGROUND_CONTEXT);
      if (!paused) harness.resume();
    },
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
              ...(parseScheduledMessage(text) ? { turnId: id } : null),
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
      await edit(item.id, (items, index) => {
        const moved = items[index];
        if (!moved) throw new Error("That message was already consumed");
        items.splice(index, 1);
        const positions = items.flatMap((entry, position) =>
          entry.mode === item.mode ? [position] : [],
        );
        items.splice(positions[input.position - 1] ?? items.length, 0, moved);
      });
      return operations.pendingMessages();
    },
    async clearQueue() {
      for (const item of await inbox()) if (item.mode !== "write") await withdraw(item.id);
      return queued();
    },
    async cancelSteering() {
      for (const item of await inbox()) if (item.mode === "steer") await withdraw(item.id);
      return queued();
    },
    async updateQueuedMessage(partId, text) {
      const item = await itemFor(partId);
      await edit(item.id, (items, index) => {
        const queuedItem = items[index];
        if (!queuedItem || queuedItem.mode === "write")
          throw new Error("That message was already consumed");
        if (
          parseCrossSessionMessage(durableQueuedText(queuedItem.content)) ||
          parseScheduledMessage(durableQueuedText(queuedItem.content))
        )
          throw new Error("That queued message cannot be edited");
        if (typeof queuedItem.content === "string")
          queuedItem.content = updateDurableInputText(queuedItem.content, text);
        else {
          const block = queuedItem.content.find((block) => block.type === "text");
          if (!block || block.type !== "text")
            throw new Error("That queued message cannot be edited");
          block.text = updateDurableInputText(block.text, text);
        }
      });
      return queued();
    },
    async removeQueuedMessage(partId) {
      const item = await itemFor(partId);
      const result = await withdraw(item.id);
      if (result === "already_placed") throw new Error("That message was already consumed");
      return queued();
    },
    async steerQueuedMessage(partId) {
      const item = await itemFor(partId);
      await edit(item.id, (items, index) => {
        const queuedItem = items[index];
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
        const [promoted] = items.splice(index, 1);
        const tail = items.findLastIndex((entry) => entry.mode === "steer");
        if (promoted) items.splice(tail + 1, 0, promoted);
      });
      return queued();
    },
    async sendQueuedMessageNow(partId) {
      const assertCurrent = await options.beforeSendNow?.();
      const item = partId
        ? await itemFor(partId)
        : (await inbox()).find((entry) => entry.mode !== "write");
      if (!item || item.mode === "write") throw new Error("No queued message to send");
      const abortedTurnIds = [...options.executingTurnIds()];
      await abortDurableActiveTurn(harness, conversation);
      await conversation.commit(async (tx) => {
        assertCurrent?.();
        const live = await tx.doc(LiveDoc, conversationId);
        if (live.run)
          throw new Error("Another run started before send-now; the queued message was retained");
        const { native, held } = await queueState(tx);
        for (const items of [held.items, native.items]) {
          const index = items.findIndex((entry) => entry.id === item.id);
          const selected = items[index];
          if (!selected || selected.mode === "write") continue;
          await startDurableInput(tx, conversationId, live, selected);
          items.splice(index, 1);
          return;
        }
        throw new Error("That message was already consumed");
      }, BACKGROUND_CONTEXT);
      harness.resume();
      return { queued: await queued(), abortedTurnIds };
    },
  };
  return { inbox, read, snapshot, requestId, submit, withdraw, observe, operations };
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

/** Place exactly this existing receipt. This is the only transaction that
 * removes it from the queue and starts its run. */
async function startDurableInput(
  tx: Tx,
  conversationId: ConversationId,
  live: Awaited<ReturnType<typeof readLive>>,
  item: HeldInput,
) {
  const model = [
    {
      role: "user" as const,
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
  ];
  const entry = item.entry
    ? await tx.appendEntry(conversationId, { ...item.entry, model })
    : await tx.appendEntry(UserEntry, conversationId, { model });
  tx.placeSubmission(item.id, entry.id);
  live.run = {
    turns: 0,
    taskId: await tx.createTask(
      GenerationTask,
      {},
      { ownership: { kind: "conversation" }, conversationId },
    ),
    inputs: [item.id],
    first: entry.id,
  };
  delete live.runFailure;
}

const readLive = (tx: Tx, conversationId: ConversationId) => tx.doc(LiveDoc, conversationId);
