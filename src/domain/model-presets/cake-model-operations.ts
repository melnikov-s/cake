import { Schema } from "effect";
import type { CakeModelPresetCatalog } from "../../contracts/model-presets/cake-model-selection";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { AgentListInput, agentListPage } from "../../contracts/agent/agent-list-data";

/** Preset discovery is separate from exact execution settings; neither exposes credentials. */
export function createCakeModelOperations(
  readPresets: () => CakeModelPresetCatalog,
): CakeOperationDefinition[] {
  const infoInput = Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  });
  return [
    {
      command: "models.list",
      topic: "models",
      summary: "List configured preset names and the current default, in bounded pages.",
      guidance: ["Filter names with query; use models.info for one preset's execution settings."],
      inputSchema: AgentListInput,
      examples: [{}],
      result: "Preset names/default flags, total, offset and nextOffset (null at the end).",
      execute: async (raw) => {
        const input = Schema.decodeUnknownSync(AgentListInput)(raw);
        const state = readPresets();
        const query = input.query?.toLowerCase();
        const presets = state.presets.filter(
          (preset) => !query || preset.name.toLowerCase().includes(query),
        );
        const { items, ...page } = agentListPage(presets, input);
        return {
          ...page,
          presets: items.map(({ id, name }) => ({ name, default: id === state.defaultPresetId })),
        };
      },
    },
    {
      command: "models.info",
      topic: "models",
      summary: "Inspect one configured model preset by its exact name.",
      inputSchema: infoInput,
      examples: [{ input: { name: "Sol" } }],
      result:
        "The preset's provider, model ID, thinking level, Fast mode and default flag, without credentials.",
      execute: async (raw) => {
        const { name } = Schema.decodeUnknownSync(infoInput)(raw);
        const state = readPresets();
        const preset = state.presets.find((candidate) => candidate.name === name);
        if (!preset)
          throw new Error(`Unknown model preset "${name}". Discover names with models.list.`);
        return {
          name: preset.name,
          provider: preset.provider,
          modelId: preset.modelId,
          thinkingLevel: preset.thinkingLevel,
          fastMode: preset.fastMode,
          default: preset.id === state.defaultPresetId,
        };
      },
    },
  ];
}
