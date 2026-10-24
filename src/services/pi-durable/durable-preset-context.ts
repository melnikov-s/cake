import { defineDoc, type PromptSection } from "@earendil-works/pi-durable";
import { Schema } from "effect";
import { PresetContext, presetGuidance } from "../../contracts/model-presets/preset-context";

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

export const presetContextSection: PromptSection = {
  key: "model_preset",
  async render(input, context) {
    const state = await input.read.snapshot(PresetContextDoc, input.conversationId, context);
    return presetGuidance(state?.preset);
  },
};
