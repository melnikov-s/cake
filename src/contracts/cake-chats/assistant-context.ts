import { Schema } from "effect";

export const AssistantContext = Schema.Struct({
  sessionId: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  mode: Schema.NonEmptyString.check(Schema.isMaxLength(80)),
});
export interface AssistantContext extends Schema.Schema.Type<typeof AssistantContext> {}

export const sameAssistantContext = (a: AssistantContext | null, b: AssistantContext | null) =>
  a?.sessionId === b?.sessionId && a?.mode === b?.mode;
