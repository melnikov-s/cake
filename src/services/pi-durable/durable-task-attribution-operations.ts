import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Conversation, EntryId } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { ProjectTodo } from "../../contracts/projects/project-todos";
import { TaskAttributionDoc } from "./durable-task-attribution";

const Input = Schema.Struct({
  entryId: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
  todoId: Schema.NullOr(ProjectTodo.fields.id),
});

/** Explicit repair of settled display metadata, never of transcript originals. */
export function taskAttributionOperations(options: {
  conversation(): Conversation;
  todos(): readonly ProjectTodo[];
}): CakeOperationDefinition[] {
  return [
    {
      command: "messages.set-todo",
      topic: "messages",
      summary: "Correct a historical human turn's to-do display grouping in this chat.",
      guidance: [
        "Use only for an explicit user-requested grouping correction. entryId is the original Durable user entry ID from archive recall, not a zoom range ID.",
        "Only settled human-turn attributions in this conversation can be corrected. todoId must be an existing to-do in this chat, or null to leave the turn ungrouped. This changes no message text, to-do content, or session association.",
      ],
      inputSchema: Input,
      outputSchema: Input,
      examples: [{ input: { entryId: "42", todoId: null } }],
      result:
        "The corrected entryId and todoId; transcript projections refresh from this metadata.",
      async execute(input) {
        const { entryId, todoId } = await Schema.decodeUnknownPromise(Input)(input);
        const id = Number(entryId);
        if (!Number.isSafeInteger(id)) throw new Error("Invalid original user entry ID");
        if (todoId !== null && !options.todos().some((todo) => todo.id === todoId))
          throw new Error("The to-do is not in this chat");
        const conversation = options.conversation();
        await conversation.commit(async (tx) => {
          // SAFETY: the schema and safe-integer check above validate Durable's numeric ID.
          const entry = await tx.entry(id as EntryId);
          const doc = await tx.doc(TaskAttributionDoc, conversation.id);
          const attribution = doc.inputs[String(id)];
          if (
            entry?.conversationId !== conversation.id ||
            entry.kind !== "pi.user" ||
            !attribution ||
            attribution.pending
          )
            throw new Error("A settled human-turn attribution in this chat is required");
          doc.inputs[String(id)] = { pending: false, todoId };
        }, BACKGROUND_CONTEXT);
        return { entryId: String(id), todoId };
      },
    },
  ];
}
