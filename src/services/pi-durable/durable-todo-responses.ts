import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  defineDoc,
  GenerationTask,
  type Conversation,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Storage,
  type TaskId,
} from "@earendil-works/pi-durable";
import { messageReference } from "../../contracts/conversations/message-reference";
import { cakeChatSideChatSessionId } from "../../contracts/cake-chats/cake-chat-identity";
import { visibleTaskAttributionContent } from "../pi/runtime/task-attribution-presentation";

/** Only in-flight generation identities. The SDK task owns the exact persisted answer ID. */
export const PendingTodoResponses = defineDoc<{
  generations: Record<string, { taskId: TaskId; conversationId: ConversationId; todoId: string }>;
}>({
  kind: "cake.pending-todo-responses",
  scope: "session",
  version: 1,
  checkpointWhen: () => false,
  initial: () => ({ generations: {} }),
});

export type AttachTodoResponse = (todoId: string, ref: string, score: number) => Promise<void>;

function responseScore(entry: EntryRecord | undefined) {
  if (entry?.kind !== "pi.assistant") return 0;
  const message = entry.model?.find((part) => part.role === "assistant");
  if (
    !message ||
    (message.stopReason !== "stop" &&
      message.stopReason !== "length" &&
      message.stopReason !== "toolUse")
  )
    return 0;
  const prose = visibleTaskAttributionContent(message.content)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  // Match entire short acknowledgements, not short but useful answers such as "Use SQLite."
  const acknowledgement =
    /^(?:ok(?:ay)?|sure(?: thing)?|thanks(?: so much)?|thank you|got it|noted|understood|acknowledged|on it|done|will do|sounds good|i(?:['’]ll| will) (?:do (?:that|it)|take a look|get started|check(?: that)?))(?:[\p{P}\s]+|$)/iu;
  const content = prose.replace(/[*_`]/g, "").trim().toLowerCase();
  let rest = content;
  while (acknowledgement.test(rest)) rest = rest.replace(acknowledgement, "");
  return /[\p{L}\p{N}]/u.test(rest) ? prose.length : 0;
}

/** One commit consumer per owning chat database (including its side chats). Task
 * receipts carry the exact entry, never a nearby or latest assistant message. */
export function observeTodoResponses(options: {
  harness: Harness;
  root: Conversation;
  storage: Storage;
  sessionId: string;
  attach: AttachTodoResponse;
  onReport(error: unknown): void;
}) {
  const { harness, root, storage, attach } = options;
  type Task = NonNullable<Awaited<ReturnType<Storage["task"]>>>;
  let work = Promise.resolve();
  const enqueue = (run: () => Promise<void>) => {
    work = work.then(run).catch(options.onReport);
  };
  const reconcile = async (task: Task) => {
    if (task.kind !== GenerationTask.definition.name) return;
    const checkpoint = task.state.checkpoint;
    const outcome = task.state.outcome;
    const committedId =
      checkpoint &&
      typeof checkpoint === "object" &&
      "phase" in checkpoint &&
      checkpoint.phase === "tools" &&
      "assistant" in checkpoint
        ? checkpoint.assistant
        : outcome?.status === "completed" &&
            outcome.result &&
            typeof outcome.result === "object" &&
            "entryId" in outcome.result
          ? outcome.result.entryId
          : undefined;
    if (committedId === undefined && !outcome) return;
    const key = String(task.id);
    const pending = await harness.snapshot(PendingTodoResponses, BACKGROUND_CONTEXT);
    const binding = pending?.generations[key];
    if (!binding || binding.conversationId !== task.conversationId) return;
    if (typeof committedId === "number" && Number.isSafeInteger(committedId) && committedId > 0) {
      // SAFETY: checked the SDK generation receipt's positive integral entry identity.
      const original = await storage.entry(committedId as EntryId, BACKGROUND_CONTEXT);
      if (original?.entry.conversationId === binding.conversationId) {
        const score = responseScore(original.entry);
        if (score) {
          const sessionId =
            binding.conversationId === root.id
              ? options.sessionId
              : cakeChatSideChatSessionId(binding.conversationId, options.sessionId);
          await attach(binding.todoId, messageReference(sessionId, String(committedId)), score);
        }
      }
    }
    // If Cake stopped after the application commit but before this deletion,
    // reopen sees the exact same ref and attachment is a no-op.
    await root.commit(async (tx) => {
      delete (await tx.doc(PendingTodoResponses)).generations[key];
    }, BACKGROUND_CONTEXT);
  };
  const commits = harness.observeCommits({
    advance({ changes }) {
      for (const change of changes)
        if (change.type === "task" && change.value.kind === GenerationTask.definition.name)
          enqueue(() => reconcile(change.value));
    },
    end() {},
  });
  enqueue(async () => {
    const pending = await harness.snapshot(PendingTodoResponses, BACKGROUND_CONTEXT);
    for (const binding of Object.values(pending?.generations ?? {})) {
      const task = await storage.task(binding.taskId, BACKGROUND_CONTEXT);
      if (task) await reconcile(task);
    }
  });
  return {
    async close() {
      commits.detach();
      await work;
    },
  };
}
