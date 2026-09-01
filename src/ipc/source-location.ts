import { Schema } from "effect";

const boundedPosition = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(10_000_000),
);
const boundedText = (maximum: number) =>
  Schema.Trim.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(maximum)));

/** A zero-based position in a workspace document. */
const sourcePositionSchema = Schema.Struct({
  line: boundedPosition,
  column: Schema.optional(boundedPosition),
});

/**
 * A workspace-relative source location. Ranges are inclusive by line; when an
 * end column is present it follows VS Code's exclusive-end range convention.
 */
export const sourceRangeSchema = Schema.Struct({
  start: sourcePositionSchema,
  end: Schema.optional(sourcePositionSchema),
});

export const sourceLocationSchema = Schema.Struct({
  path: boundedText(8_192),
  /** Prefer VS Code's native working-tree diff when opening this file. */
  view: Schema.optional(Schema.Literal("changes")),
  range: Schema.optional(sourceRangeSchema),
  symbol: Schema.optional(boundedText(1_024)),
  documentVersion: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(0),
      Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
    ),
  ),
});

export type SourcePosition = typeof sourcePositionSchema.Type;
export type SourceRange = typeof sourceRangeSchema.Type;
export type SourceLocation = typeof sourceLocationSchema.Type;
