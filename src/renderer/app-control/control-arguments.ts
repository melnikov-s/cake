import { Schema } from "effect";

export const bounded = (minimum: number, maximum: number) =>
  Schema.String.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum));
export const trimmed = (minimum: number, maximum: number) =>
  Schema.Trim.pipe(Schema.check(Schema.isMinLength(minimum), Schema.isMaxLength(maximum)));
export const sessionIdTargetSchema = Schema.Struct({ sessionId: bounded(1, 256) });
export const sessionNavigationTargetSchema = Schema.Struct({
  ...sessionIdTargetSchema.fields,
  messageId: Schema.optionalKey(bounded(1, 256)),
});
export const emptyArgumentsSchema = Schema.Struct({});
