import { Schema } from "effect";
import { BoardAppendInput } from "../artifacts/message-board";

/** Cake persists this addressed Workboard entry before admitting the first child turn. */
export const ChildSessionAssignment = Schema.Struct({
  description: BoardAppendInput.fields.description,
  body: BoardAppendInput.fields.body,
});
export interface ChildSessionAssignment extends Schema.Schema.Type<typeof ChildSessionAssignment> {}
