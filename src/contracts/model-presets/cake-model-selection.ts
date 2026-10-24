import { PresetContext } from "./preset-context";
import { Effect, Schema } from "effect";
import type { ModelPreset, UtilityModel } from "../application/application-data";
import { ThinkingLevel } from "../pi/model-data";

const trimmed = (maximum: number) =>
  Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maximum)));

/** Cake tool input: a preset name or an execution-ready configuration. */
export const ExplicitCakeModelSelection = Schema.Struct({
  preset: Schema.optionalKey(PresetContext),
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

/**
 * A stored Cake Chat model setting (Subagent default model, Summarization model). Each
 * setting has its own unstored default source.
 * - default: the configured default model preset.
 * - inherit: Cake Chat's current model, thinking level, and Fast mode.
 * - utility: the configured utility model (Fast mode off).
 * - preset: one configured preset, referenced by ID so renames keep working.
 * - model: one explicit provider, model ID, thinking level, and Fast mode.
 */
export const CakeModelChoice = Schema.Union([
  Schema.Struct({ source: Schema.Literal("default") }),
  Schema.Struct({ source: Schema.Literal("inherit") }),
  Schema.Struct({ source: Schema.Literal("utility") }),
  Schema.Struct({
    source: Schema.Literal("preset"),
    presetId: Schema.String.check(Schema.isUUID(4)),
  }),
  Schema.Struct({ source: Schema.Literal("model"), model: ExplicitCakeModelSelection }),
]);
export type CakeModelChoice = typeof CakeModelChoice.Type;

/**
 * Which launch path is resolving a model. An omitted model on a `session` launch (sessions,
 * drafts, children, workflow agents, and Project Session subagents) uses the default preset;
 * on a Cake Chat `subagent` launch it follows the catalog's `subagentDefaultModel` setting
 * (absent means `inherit`).
 */
export type CakeModelLaunch = "session" | "subagent";

/** Cake-owned model configuration snapshot read at operation execution time. */
export interface CakeModelPresetCatalog {
  readonly presets: readonly ModelPreset[];
  readonly defaultPresetId?: string;
  readonly utilityModel?: UtilityModel;
  readonly subagentDefaultModel?: CakeModelChoice;
}
