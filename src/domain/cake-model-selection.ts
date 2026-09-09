import { Effect, Predicate, Schema } from "effect";
import type { ModelPreset } from "./application-data";
import { ThinkingLevel } from "../services/pi/model-data";

const trimmed = (maximum: number) =>
  Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maximum)));

export const ExplicitCakeModelSelection = Schema.Struct({
  provider: trimmed(256),
  modelId: trimmed(512),
  thinkingLevel: ThinkingLevel,
  fastMode: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});

/** A preset name or a concrete, execution-ready model configuration. */
export const CakeModelSelection = Schema.Union([
  trimmed(80).annotate({
    description: "Configured Cake model preset name. Strings are never raw model IDs.",
  }),
  ExplicitCakeModelSelection,
]);

export type ExplicitCakeModelSelection = typeof ExplicitCakeModelSelection.Type;
export type CakeModelSelection = typeof CakeModelSelection.Type;

export interface CakeModelPresetCatalog {
  readonly presets: readonly ModelPreset[];
  readonly defaultPresetId?: string;
}

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
