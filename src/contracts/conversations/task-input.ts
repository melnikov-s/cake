import { Schema } from "effect";

/** Coordinator-safe metadata. Never add previews, extracted text, or backend paths here. */
export const TaskInputReference = Schema.Struct({
  kind: Schema.Literal("input"),
  id: Schema.String.check(Schema.isUUID(4)),
  name: Schema.String.check(Schema.isMaxLength(512)),
  mimeType: Schema.String.check(Schema.isMaxLength(128)),
  byteLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export interface TaskInputReference extends Schema.Schema.Type<typeof TaskInputReference> {}

/** Name of the reference that replaces composer annotations in coordinator (Cake Chat) admission. */
export const ANNOTATIONS_INPUT_NAME = "Annotations";

export const inputRefsSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
).check(Schema.isMaxLength(20));

const LARGE_PASTE_CHARACTERS = 4_000;
const LARGE_PASTE_LINES = 40;
export const MAX_PASTED_TEXT_BYTES = 8 * 1024 * 1024;
export function isLargePaste(text: string): boolean {
  return text.length >= LARGE_PASTE_CHARACTERS || text.split("\n").length >= LARGE_PASTE_LINES;
}
