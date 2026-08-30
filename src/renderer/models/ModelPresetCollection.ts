import { Schema } from "effect";
import { Model, batch, createModel, type ModelInstance } from "effect-state-tree";
import { ModelPresetUpdateInput } from "../../ipc/protocol/modelPresets";
import { ModelPreset } from "./ModelPreset";

export const ModelPresetCollection = createModel(
  "ModelPresetCollection",
  Schema.Struct({
    presets: Schema.Array(Model.child(ModelPreset.schema)),
    defaultPresetId: Schema.optional(ModelPresetUpdateInput.fields.id),
  }),
  (self) => ({
    replace(presets: ReadonlyArray<ModelPreset>, defaultPresetId: string | undefined) {
      if (
        defaultPresetId !== undefined &&
        !presets.some((preset) => preset.id.value === defaultPresetId)
      )
        throw new Error("The default Model Preset must belong to the authoritative projection");

      const retained = new Set(presets);
      const removed = self.presets.value.filter((preset) => !retained.has(preset));
      batch(() => {
        self.presets.set([...presets]);
        self.defaultPresetId.set(defaultPresetId);
      });
      for (const preset of removed) preset[Symbol.dispose]();
    },
  }),
);

export type ModelPresetCollection = ModelInstance<typeof ModelPresetCollection>;
