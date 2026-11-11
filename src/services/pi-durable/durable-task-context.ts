import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  LiveDoc,
  type Conversation,
  type Harness,
  type InboxItem,
  type Storage,
} from "@earendil-works/pi-durable";
import type { ProjectTodo } from "../../contracts/projects/project-todos";
import { parseCrossSessionMessage } from "../../contracts/conversations/cross-session-message";
import { isAutomaticInput } from "../pi/runtime/internal-input-projection";
import { durableInputPresentation, type DurableTaskContext } from "./durable-input-presentation";
import { TaskAttributionDoc } from "./durable-task-attribution";

/** The selected follow-up reuses a known task: reject model-requested creation
 * before it can reach any task naming/creation work. Other turns remain unchanged. */
export async function assertTaskCreationAllowed(
  conversation: Conversation,
  harness: Harness,
  storage: Storage,
): Promise<void> {
  const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
  for (const id of (live?.run?.inputs ?? []).toReversed()) {
    const submission = await storage.submission(id, BACKGROUND_CONTEXT);
    if (submission?.status !== "placed") continue;
    const entry = await storage.entry(conversation.id, submission.entry, BACKGROUND_CONTEXT);
    for (const message of (entry?.entry.model ?? []).toReversed()) {
      if (message.role !== "user") continue;
      const input = durableInputPresentation(
        typeof message.content === "string"
          ? message.content
          : message.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n"),
      );
      if (!input.attribution) continue;
      if (input.taskContext?.first)
        throw new Error(
          `This message explicitly continues existing to-do ${input.taskContext.todoId}; do not create or title another to-do.`,
        );
      return;
    }
  }
}

/** Recover explicit context from Pi's queued inputs/originals, never window focus or
 * the last model-selected task. Each send captures its own context, so late results
 * cannot overwrite a newer attention selection. Withdrawn queued inputs disappear
 * naturally; persisted originals recover the same context after a restart. */
export async function previousDurableTaskContext(
  conversation: Conversation,
  inbox: readonly InboxItem[],
  todos: readonly ProjectTodo[],
): Promise<DurableTaskContext | undefined> {
  return conversation.commit(async (tx) => {
    const attributions = (await tx.doc(TaskAttributionDoc, conversation.id)).inputs;
    const read = (
      content: string | ReadonlyArray<{ type: string; text?: string }>,
      entryId?: string,
    ): { context: DurableTaskContext | undefined } | undefined => {
      const input = durableInputPresentation(
        typeof content === "string"
          ? content
          : content
              .flatMap((block) => (block.type === "text" ? [block.text ?? ""] : []))
              .join("\n"),
      );
      const active = (id: string) =>
        todos.some((todo) => todo.id === id && todo.state === "open" && !todo.snoozedUntil);
      if (input.internal?._tag === "AttentionItem")
        return {
          context: active(input.internal.todoId)
            ? { todoId: input.internal.todoId, first: true }
            : undefined,
        };
      // Reports and other automatic inputs neither consume nor replace selection.
      if (
        !input.attribution ||
        isAutomaticInput(input.internal) ||
        input.subagentReport ||
        parseCrossSessionMessage(input.text)
      )
        return undefined;
      const selected = input.taskContext;
      const settled = entryId === undefined ? undefined : attributions[entryId];
      // A deliberate new-topic decision ends the handoff. Normal inference resumes.
      return {
        context:
          selected && active(selected.todoId) && !settled?.contextEnded
            ? { todoId: selected.todoId, first: false }
            : undefined,
      };
    };
    for (const item of inbox.toReversed()) {
      if (item.mode === "write") continue;
      const result = read(item.content);
      if (result) return result.context;
    }
    let cursor;
    do {
      const page = await tx.scanEntries(
        { conversationId: conversation.id, order: "descending" },
        64,
        cursor,
      );
      for (const entry of page.items) {
        if (entry.kind !== "pi.user") continue;
        for (const message of (entry.model ?? []).toReversed()) {
          if (message.role !== "user") continue;
          const result = read(message.content, String(entry.id));
          if (result) return result.context;
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
    return undefined;
  }, BACKGROUND_CONTEXT);
}
