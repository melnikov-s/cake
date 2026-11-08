import { Schema } from "effect";
import { ProjectTodos } from "./project-todos";

/** Admission is not navigation: only the initiating window may reveal these exact originals. */
export const AttentionActivation = Schema.Struct({
  todos: ProjectTodos,
  responseTurnId: Schema.String,
  resultPartIds: Schema.Array(Schema.String),
});
export interface AttentionActivation extends Schema.Schema.Type<typeof AttentionActivation> {}
