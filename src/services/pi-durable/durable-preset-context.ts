import { defineDoc, type PromptSection } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { PresetContext, presetGuidance } from "../../contracts/model-presets/preset-context";
import { loadPresetContext } from "../storage/load-preset-context";
import type { CakeModelPresetCatalog } from "../../contracts/model-presets/cake-model-selection";

export const PresetState = Schema.Struct({ preset: Schema.optionalKey(PresetContext) });
export const PresetContextDoc = defineDoc<Schema.Schema.Type<typeof PresetState>>({
  kind: "cake.model-preset",
  version: 1,
  scope: "conversation",
  checkpointWhen: () => false,
  history: "rewindable",
  fork: "asOf",
  initial: () => ({}),
});

export const presetContextSection = (
  modelPresets?: () => CakeModelPresetCatalog,
): PromptSection => ({
  key: "model_preset",
  async render(input, context) {
    const state = await input.read.snapshot(PresetContextDoc, input.conversationId, context);
    return presetGuidance(await loadPresetContext(state?.preset, modelPresets?.().presets));
  },
});
