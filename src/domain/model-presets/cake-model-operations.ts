import { Schema } from "effect";
import { compactDiscoveryGuidance } from "../../contracts/agent/discovery-result-text";
import {
  CakeModelSelection,
  type CakeModelPresetCatalog,
} from "../../contracts/model-presets/cake-model-selection";
import { serializeModelReference } from "../../contracts/model-presets/model-reference";
import { resolveCakeModelSelection } from "./cake-model-selection";
import type { CakeOperationDefinition } from "../../contracts/agent/cake-operation";
import { AgentListInput, agentListPage } from "../../contracts/agent/agent-list-data";

/** Preset discovery is separate from exact execution settings; neither exposes credentials. */
export function createCakeModelOperations(
  readPresets: () => CakeModelPresetCatalog,
): CakeOperationDefinition[] {
  const infoInput = Schema.Struct({
    name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  });
  const referenceInput = Schema.Struct({ model: CakeModelSelection });
  return [
    {
      command: "models.reference",
      topic: "models",
      summary:
        "Create an inline model reference for message text, without changing a session or launching an agent.",
      inputSchema: referenceInput,
      examples: [{ input: { model: "Sol" } }],
      result:
        "text: the canonical reference token to insert into an existing message body. Presets retain identity and a settings snapshot.",
      guidance: [
        "Use the returned text with ordinary message-send operations. Native caret placement and opening the picker are local editing actions; this operation creates the same reference without controlling the desktop.",
      ],
      execute: async (raw) => {
        const { model } = Schema.decodeUnknownSync(referenceInput)(raw);
        const catalog = readPresets();
        const selection = resolveCakeModelSelection(model, catalog);
        const preset = catalog.presets.find((preset) => preset.id === selection.preset?.id);
        return {
          text: serializeModelReference({
            ...selection,
            ...(preset ? { presetName: preset.name } : null),
          }),
        };
      },
    },
    {
      command: "models.list",
      topic: "models",
      summary: "List configured preset names and the current default, in bounded pages.",
      guidance: [
        "Filter names with query; use models.info for one preset's execution settings.",
        compactDiscoveryGuidance,
      ],
      inputSchema: AgentListInput,
      examples: [{}],
      result: "Compact default/name rows, total and next=N when another page exists.",
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
        "The preset's provider, model ID, thinking level, Fast mode, optional prompt file reference and default flag, without credentials.",
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
          ...(preset.promptFile === undefined ? null : { promptFile: preset.promptFile }),
          default: preset.id === state.defaultPresetId,
        };
      },
    },
  ];
}
