import { Option, Schema } from "effect";
import { splitReferenceNotifications } from "../conversations/reference-notification";
import { splitSessionDigestReminder } from "../cake-chats/session-digest-reminder";
import { ProjectTodo, ProjectTodoUserChange } from "./project-todos";

const block =
  /^<system-reminder>\n(?:Project|Cake) Chat user changes\. [^\n]*\n([^\n]*)\n<\/system-reminder>(?:\n\n|$)/;

/** Only the exact application-owned leading boundary is recognized. */
export function splitProjectTodoReminder(text: string) {
  const match = block.exec(text);
  return match
    ? { text: text.slice(match[0].length), reminder: match[0].trimEnd() }
    : { text, reminder: undefined };
}
const ProjectTodoSentContext = Schema.Struct({
  selection: Schema.NullOr(ProjectTodo),
  changes: Schema.Array(ProjectTodoUserChange),
});

/** Project only the snapshot in this durable input, never the current Project selection. */
export function projectTodoContextPresentation(reminder: string) {
  const payload = block.exec(reminder)?.[1];
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectTodoSentContext))(payload);
  const fallback = reminder.startsWith("<system-reminder>\nCake Chat")
    ? "Cake · Cake Chat changes"
    : "Cake · Project Chat changes";
  if (Option.isNone(parsed)) return { title: fallback, text: reminder };
  const { selection, changes } = parsed.value;
  return {
    title: selection ? `To-do · ${selection.title}` : fallback,
    text: `\`\`\`json\n${JSON.stringify({ selection, changes }, null, 2)}\n\`\`\``,
  };
}

export const ProjectTodoContextReceipt = Schema.Struct({
  sequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  token: Schema.String.check(Schema.isUUID(4)),
});
export interface ProjectTodoContextReceipt extends Schema.Schema.Type<
  typeof ProjectTodoContextReceipt
> {}

export function projectTodoReceipt(text: string): ProjectTodoContextReceipt | undefined {
  const payload = block.exec(
    splitSessionDigestReminder(splitReferenceNotifications(text).text).text,
  )?.[1];
  if (!payload) return undefined;
  const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectTodoContextReceipt))(
    payload,
  );
  return Option.isSome(parsed) ? parsed.value : undefined;
}
