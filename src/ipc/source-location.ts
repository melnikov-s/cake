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

const sourceRangesSchema = Schema.Array(sourceRangeSchema).check(
  Schema.isMinLength(2),
  Schema.isMaxLength(32),
);

/**
 * One Git revision such as `HEAD~1`, `main`, `origin/main`, `@{upstream}`, or a
 * SHA. The companion passes it to `git diff <base> -- <path>`, so option-like
 * values, `a..b` ranges, `ref:path` forms, and whitespace are rejected.
 */
export const gitRevisionSchema = Schema.Trim.pipe(
  Schema.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.isPattern(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/@{}^~-]+$/),
  ),
);

export const sourceLocationSchema = Schema.Struct({
  path: boundedText(8_192),
  /** Prefer VS Code's native working-tree diff when opening this file. */
  view: Schema.optional(Schema.Literal("changes")),
  /** Side of a native diff to reveal; omitted means the changed (after) side. */
  side: Schema.optional(Schema.Literals(["before", "after"])),
  /** Revision the working tree is compared with in the changes view; omitted means HEAD. */
  base: Schema.optional(gitRevisionSchema),
  range: Schema.optional(sourceRangeSchema),
  /** Disjoint ranges in one document, ordered as they should be presented. */
  ranges: Schema.optional(sourceRangesSchema),
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
