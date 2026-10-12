import { Effect, Schema } from "effect";
import type { ModelPreset } from "../application/application-data";
import { ThinkingLevel } from "../pi/model-data";

const trimmed = (maximum: number) =>
  Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maximum)));

/** Cake tool input: a preset name or an execution-ready configuration. */
export const ExplicitCakeModelSelection = Schema.Struct({
  provider: trimmed(256),
  modelId: trimmed(512),
  thinkingLevel: ThinkingLevel,
  fastMode: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
});

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
