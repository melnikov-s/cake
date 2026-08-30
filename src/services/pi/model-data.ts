import { Schema } from "effect";

const nonEmptyBoundedString = (maximum: number) =>
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));

export const ThinkingLevel = Schema.Literals([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const PiModel = Schema.Struct({
  provider: nonEmptyBoundedString(256),
  providerName: nonEmptyBoundedString(512),
  id: nonEmptyBoundedString(512),
  name: nonEmptyBoundedString(1_024),
  reasoning: Schema.Boolean,
  supportedThinkingLevels: Schema.Array(ThinkingLevel).check(
    Schema.isMaxLength(7),
    Schema.isUnique(),
  ),
  fastMode: Schema.Boolean,
  input: Schema.Array(Schema.Literals(["text", "image"])).check(
    Schema.isMaxLength(2),
    Schema.isUnique(),
  ),
  authenticated: Schema.Boolean,
  available: Schema.Boolean,
  authSource: Schema.optionalKey(
    Schema.Literals([
      "stored",
      "runtime",
      "environment",
      "fallback",
      "models_json_key",
      "models_json_command",
    ]),
  ),
  authLabel: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(512))),
  authTypes: Schema.Array(Schema.Literals(["api_key", "oauth"])).check(
    Schema.isMaxLength(2),
    Schema.isUnique(),
  ),
});

export const ModelSelection = Schema.Struct({
  provider: nonEmptyBoundedString(256),
  modelId: nonEmptyBoundedString(512),
  thinkingLevel: ThinkingLevel,
  fastMode: Schema.Boolean,
});

export const BoundedCompletionInput = Schema.Struct({
  selection: ModelSelection,
  instructions: nonEmptyBoundedString(32_000),
  context: Schema.String.check(Schema.isMaxLength(262_144)),
  maximumOutputCharacters: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_000 })),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 })),
});

export class UnknownPiModelError extends Schema.TaggedError<UnknownPiModelError>()(
  "UnknownPiModelError",
  { provider: Schema.String, modelId: Schema.String },
) {}

export class UnauthenticatedPiModelError extends Schema.TaggedError<UnauthenticatedPiModelError>()(
  "UnauthenticatedPiModelError",
  { provider: Schema.String, modelId: Schema.String },
) {}

export class UnavailablePiModelError extends Schema.TaggedError<UnavailablePiModelError>()(
  "UnavailablePiModelError",
  { provider: Schema.String, modelId: Schema.String },
) {}

export class UnsupportedThinkingLevelError extends Schema.TaggedError<UnsupportedThinkingLevelError>()(
  "UnsupportedThinkingLevelError",
  {
    provider: Schema.String,
    modelId: Schema.String,
    thinkingLevel: ThinkingLevel,
    supportedThinkingLevels: Schema.Array(ThinkingLevel),
  },
) {}

export class UnsupportedFastModeError extends Schema.TaggedError<UnsupportedFastModeError>()(
  "UnsupportedFastModeError",
  { provider: Schema.String, modelId: Schema.String },
) {}

export class PiModelCatalogError extends Schema.TaggedError<PiModelCatalogError>()(
  "PiModelCatalogError",
  {
    operation: Schema.Literals(["load", "refresh"]),
    message: Schema.String,
  },
) {}

export class PiModelCompletionError extends Schema.TaggedError<PiModelCompletionError>()(
  "PiModelCompletionError",
  { message: Schema.String },
) {}

export type ThinkingLevel = typeof ThinkingLevel.Type;
export interface PiModel extends Schema.Schema.Type<typeof PiModel> {}
export interface ModelSelection extends Schema.Schema.Type<typeof ModelSelection> {}
export interface BoundedCompletionInput extends Schema.Schema.Type<typeof BoundedCompletionInput> {}
export type PiModelResolutionError =
  | UnknownPiModelError
  | UnauthenticatedPiModelError
  | UnavailablePiModelError
  | UnsupportedThinkingLevelError
  | UnsupportedFastModeError;
