import { Predicate } from "effect";
import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
  CakeModelPresetCatalog,
} from "../../contracts/model-presets/cake-model-selection";
import type { ModelPreset } from "../../contracts/application/application-data";

const presetConfiguration = (preset: ModelPreset): ExplicitCakeModelSelection => ({
  provider: preset.provider,
  modelId: preset.modelId,
  thinkingLevel: preset.thinkingLevel,
  fastMode: preset.fastMode,
});

/**
 * Resolves one snapshot of Cake-owned preset configuration at operation execution time.
 *
 * An omitted selection means "the user's configured default", never the caller's current
 * model: it resolves the default preset's complete configuration. `fallback` (normally the
 * caller's current configuration) applies only when no default preset is configured.
 */
export function resolveCakeModelSelection(
  selection: CakeModelSelection | undefined,
  catalog: CakeModelPresetCatalog,
  fallback?: ExplicitCakeModelSelection,
): ExplicitCakeModelSelection {
  if (selection === undefined) {
    const preset = catalog.presets.find((entry) => entry.id === catalog.defaultPresetId);
    if (preset) return presetConfiguration(preset);
    if (!fallback)
      throw new Error(
        "A model selection is required because no default model preset is configured",
      );
    return { ...fallback };
  }
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
