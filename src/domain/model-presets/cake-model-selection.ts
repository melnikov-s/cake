import { Predicate } from "effect";
import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
  CakeModelLaunch,
  CakeModelPresetCatalog,
  CakeModelChoice,
} from "../../contracts/model-presets/cake-model-selection";
import type { ApplicationState, ModelPreset } from "../../contracts/application/application-data";
import { cakeChatModelSettingDefaults } from "../../contracts/cake-chats/cake-chat-preferences";

const presetConfiguration = (preset: ModelPreset): ExplicitCakeModelSelection => ({
  provider: preset.provider,
  modelId: preset.modelId,
  thinkingLevel: preset.thinkingLevel,
  fastMode: preset.fastMode,
  preset: { id: preset.id, ...(preset.prompt === undefined ? null : { prompt: preset.prompt }) },
});

/** Snapshots the application's model configuration for execution-time resolution. */
export const cakeModelCatalog = (
  state: Pick<
    ApplicationState,
    "modelPresets" | "defaultModelPresetId" | "utilityModel" | "cakeChatPreferences"
  >,
): CakeModelPresetCatalog => ({
  presets: state.modelPresets.map((preset) => ({ ...preset })),
  defaultPresetId: state.defaultModelPresetId,
  utilityModel: state.utilityModel,
  subagentDefaultModel: state.cakeChatPreferences?.subagentDefaultModel,
});

const DEFAULT: CakeModelChoice = { source: "default" };

/**
 * Resolves one snapshot of Cake-owned preset configuration at operation execution time.
 *
 * An explicit selection is always honored exactly. An omitted selection on a `session` launch
 * uses the configured default preset, falling back to `caller` (the calling session's current
 * settings) only when no default preset is configured. On a `subagent` launch it follows the
 * catalog's Subagent default model setting (see {@link CakeModelChoice}), which only Cake
 * Chat composition requests; Project Session subagents resolve as `session` launches.
 */
export function resolveCakeModelSelection(
  selection: CakeModelSelection | undefined,
  catalog: CakeModelPresetCatalog,
  caller?: ExplicitCakeModelSelection,
  launch: CakeModelLaunch = "session",
): ExplicitCakeModelSelection {
  if (selection === undefined)
    return resolveCakeModelChoice(
      launch === "subagent"
        ? (catalog.subagentDefaultModel ?? cakeChatModelSettingDefaults.subagentDefaultModel)
        : DEFAULT,
      catalog,
      caller,
    );
  if (!Predicate.isString(selection)) return { ...selection };

  const matches = catalog.presets.filter((preset) => preset.name === selection);
  if (matches.length === 0)
    throw new Error(
      `Unknown model preset "${selection}". Call models.list to see configured presets.`,
    );
  if (matches.length > 1)
    throw new Error(`Model preset name "${selection}" is ambiguous. Rename the duplicate presets.`);
  return presetConfiguration(matches[0]!);
}

/**
 * Resolves one Cake Chat model choice. Default and Inherit fall back to each other when their
 * primary source is unavailable; a missing utility model or deleted preset fails instead of
 * substituting another model.
 */
export function resolveCakeModelChoice(
  source: CakeModelChoice,
  catalog: CakeModelPresetCatalog,
  caller: ExplicitCakeModelSelection | undefined,
): ExplicitCakeModelSelection {
  const findPreset = (id: string | undefined) => catalog.presets.find((preset) => preset.id === id);
  switch (source.source) {
    case "model":
      return { ...source.model };
    case "utility": {
      const utility = catalog.utilityModel;
      if (!utility)
        throw new Error(
          "The chosen model is the utility model, but no utility model is configured. Configure one in Settings or choose another model.",
        );
      return { ...utility, fastMode: false };
    }
    case "preset": {
      const preset = findPreset(source.presetId);
      if (!preset)
        throw new Error(
          "The chosen model preset no longer exists. Choose another model in Settings → Cake Chat.",
        );
      return presetConfiguration(preset);
    }
    case "default":
    case "inherit": {
      const preset = findPreset(catalog.defaultPresetId);
      const defaultConfiguration = preset ? presetConfiguration(preset) : undefined;
      const callerConfiguration = caller ? { ...caller } : undefined;
      const resolved =
        source.source === "inherit"
          ? (callerConfiguration ?? defaultConfiguration)
          : (defaultConfiguration ?? callerConfiguration);
      if (!resolved)
        throw new Error(
          "A model selection is required because the caller has no current model and no default model preset is configured",
        );
      return resolved;
    }
  }
}
