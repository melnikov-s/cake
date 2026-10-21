import { Option, Schema } from "effect";
import { splitReferenceNotifications } from "../conversations/reference-notification";
import { splitSessionDigestReminder } from "../cake-chats/session-digest-reminder";

const block =
  /^<system-reminder>\nProject Chat user changes\. [^\n]*\n([^\n]*)\n<\/system-reminder>(?:\n\n|$)/;

/** Only the exact application-owned leading boundary is recognized. */
export function splitProjectTodoReminder(text: string) {
  const match = block.exec(text);
  return match
    ? { text: text.slice(match[0].length), reminder: match[0].trimEnd() }
    : { text, reminder: undefined };
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
