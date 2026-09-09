import { Schema } from "effect";
import type { CakeModelPresetCatalog } from "../../../domain/cake-model-selection";
import type { CakeOperationDefinition } from "./cake-operation-registry";

/** Exposes Cake-owned model presets without provider credentials. */
export function createCakeModelOperations(
  readPresets: () => CakeModelPresetCatalog,
): CakeOperationDefinition[] {
  return [
    {
      command: "models.list",
      topic: "models",
      summary: "List configured model presets and their complete execution settings.",
      inputSchema: Schema.Struct({}),
      examples: [{}],
      result:
        "Configured preset names, providers, model IDs, thinking levels, Fast mode settings, and current default without credentials.",
      execute: async () => {
        const state = readPresets();
        return {
          presets: state.presets.map(
            ({ id, name, provider, modelId, thinkingLevel, fastMode }) => ({
              name,
              provider,
              modelId,
              thinkingLevel,
              fastMode,
              default: id === state.defaultPresetId,
            }),
          ),
        };
      },
    },
  ];
}
