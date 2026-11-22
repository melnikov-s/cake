import { Schema } from "effect";

export const AntigravityModelOption = Schema.Struct({
  modelId: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
  name: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
});
export interface AntigravityModelOption extends Schema.Schema.Type<typeof AntigravityModelOption> {}

/** An error with models means the last successful result is stale. */
export const AntigravityCatalog = Schema.Struct({
  models: Schema.Array(AntigravityModelOption),
  error: Schema.optionalKey(Schema.String),
});
export interface AntigravityCatalog extends Schema.Schema.Type<typeof AntigravityCatalog> {}
