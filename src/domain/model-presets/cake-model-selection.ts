import { Predicate } from "effect";
import type {
  CakeModelSelection,
  ExplicitCakeModelSelection,
  CakeModelPresetCatalog,
} from "../../contracts/model-presets/cake-model-selection";

/** Resolves one snapshot of Cake-owned preset configuration at operation execution time. */
export function resolveCakeModelSelection(
  selection: CakeModelSelection | undefined,
  catalog: CakeModelPresetCatalog,
  inherited?: ExplicitCakeModelSelection,
): ExplicitCakeModelSelection {
  if (selection === undefined) {
    if (!inherited)
      throw new Error("A model selection is required because there is no model to inherit");
    return { ...inherited };
  }
  if (!Predicate.isString(selection)) return { ...selection };

  const matches = catalog.presets.filter((preset) => preset.name === selection);
  if (matches.length === 0)
    throw new Error(
      `Unknown model preset "${selection}". Call models.list to see configured presets.`,
    );
  if (matches.length > 1)
    throw new Error(`Model preset name "${selection}" is ambiguous. Rename the duplicate presets.`);
  const preset = matches[0]!;
  return {
    provider: preset.provider,
    modelId: preset.modelId,
    thinkingLevel: preset.thinkingLevel,
    fastMode: preset.fastMode,
  };
}
