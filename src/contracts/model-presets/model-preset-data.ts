import { Schema } from "effect";
import { ModelPreset } from "../application/application-data";

export const ModelPresetCreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(80)),
  provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  modelId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  thinkingLevel: ModelPreset.fields.thinkingLevel,
  fastMode: Schema.Boolean,
});

export const ModelPresetUpdateInput = ModelPreset;

export const ModelPresetOrderInput = Schema.Struct({
  ids: Schema.Array(Schema.String.check(Schema.isUUID(4))).check(Schema.isMaxLength(100)),
});

export const ModelPresetProjection = Schema.Struct({
  presets: Schema.Array(ModelPreset).check(Schema.isMaxLength(100)),
  // Projection constructors always include this key; undefined means no default.
  defaultPresetId: Schema.optional(Schema.String.check(Schema.isUUID(4))),
}).check(
  Schema.makeFilter(
    (state) => {
      const ids = state.presets.map((preset) => preset.id);
      return (
        new Set(ids).size === ids.length &&
        (state.defaultPresetId === undefined || ids.includes(state.defaultPresetId))
      );
    },
    { expected: "unique Model Preset identities with a valid default preset" },
  ),
);

export class ModelPresetValidationError extends Schema.TaggedError<ModelPresetValidationError>()(
  "ModelPresetValidationError",
  { message: Schema.String },
) {}

export class ModelPresetNotFoundError extends Schema.TaggedError<ModelPresetNotFoundError>()(
  "ModelPresetNotFoundError",
  { id: Schema.String },
) {}

export class DefaultModelPresetNotFoundError extends Schema.TaggedError<DefaultModelPresetNotFoundError>()(
  "DefaultModelPresetNotFoundError",
  { id: Schema.String },
) {}

export class DuplicateModelPresetIdError extends Schema.TaggedError<DuplicateModelPresetIdError>()(
  "DuplicateModelPresetIdError",
  { id: Schema.String },
) {}

export class ModelPresetLimitError extends Schema.TaggedError<ModelPresetLimitError>()(
  "ModelPresetLimitError",
  { limit: Schema.Int },
) {}

export interface ModelPresetCreateInput extends Schema.Schema.Type<typeof ModelPresetCreateInput> {}

export interface ModelPresetUpdateInput extends Schema.Schema.Type<typeof ModelPresetUpdateInput> {}

export interface ModelPresetOrderInput extends Schema.Schema.Type<typeof ModelPresetOrderInput> {}

export interface ModelPresetProjection extends Schema.Schema.Type<typeof ModelPresetProjection> {}
