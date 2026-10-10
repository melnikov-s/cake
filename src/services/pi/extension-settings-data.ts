import { Schema } from "effect";

export const PiExtensionSetting = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  path: Schema.NonEmptyString,
  source: Schema.String,
  enabled: Schema.Boolean,
});
export interface PiExtensionSetting extends Schema.Schema.Type<typeof PiExtensionSetting> {}

export const PiExtensionToggle = Schema.Struct({
  id: Schema.NonEmptyString,
  enabled: Schema.Boolean,
});
export interface PiExtensionToggle extends Schema.Schema.Type<typeof PiExtensionToggle> {}
