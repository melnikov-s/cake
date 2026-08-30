import { Schema } from "effect";
import { Model, createModel, type ModelInstance } from "effect-state-tree";
import { ModelPresetUpdateInput } from "../../ipc/protocol/modelPresets";

export const ModelPreset = createModel(
  "ModelPreset",
  Schema.Struct({
    id: Model.id(ModelPresetUpdateInput.fields.id),
    name: ModelPresetUpdateInput.fields.name,
    provider: ModelPresetUpdateInput.fields.provider,
    modelId: ModelPresetUpdateInput.fields.modelId,
    thinkingLevel: ModelPresetUpdateInput.fields.thinkingLevel,
    fastMode: ModelPresetUpdateInput.fields.fastMode,
  }),
);

export type ModelPreset = ModelInstance<typeof ModelPreset>;
