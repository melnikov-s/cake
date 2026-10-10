import { Schema } from "effect";

export const NonChatModelType = Schema.Literals(["image", "classifier"]);
export type NonChatModelType = typeof NonChatModelType.Type;

export const NonChatModelReference = Schema.Struct({
  provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
});
export interface NonChatModelReference extends Schema.Schema.Type<typeof NonChatModelReference> {}

/** Persisted advisory Cake application preferences, not Pi provider configuration. */
export const NonChatModelPreferences = Schema.Struct({
  image: Schema.optionalKey(NonChatModelReference),
  classifier: Schema.optionalKey(NonChatModelReference),
});
export interface NonChatModelPreferences extends Schema.Schema.Type<
  typeof NonChatModelPreferences
> {}

export const NonChatModelPreferenceUpdate = Schema.Struct({
  type: NonChatModelType,
  preference: Schema.NullOr(NonChatModelReference),
});
export interface NonChatModelPreferenceUpdate extends Schema.Schema.Type<
  typeof NonChatModelPreferenceUpdate
> {}
