import { Schema } from "effect";

export const OptMemoryId = Schema.String.check(Schema.isUUID(4)).pipe(Schema.brand("OptMemoryId"));
export type OptMemoryId = typeof OptMemoryId.Type;

/** Stable tree coordinates. Domain validation requires an aligned power-of-two range. */
export const OptMemoryRange = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  n: Schema.Int.check(Schema.isGreaterThan(0)),
});
export interface OptMemoryRange extends Schema.Schema.Type<typeof OptMemoryRange> {}

export const OptMemoryLine = Schema.Struct({
  range: OptMemoryRange,
  text: Schema.String,
  depth: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export interface OptMemoryLine extends Schema.Schema.Type<typeof OptMemoryLine> {}

export const OptMemoryView = Schema.Struct({
  lines: Schema.Array(OptMemoryLine),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  budgetBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  sourceCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export interface OptMemoryView extends Schema.Schema.Type<typeof OptMemoryView> {}

export const OptMemoryReadInput = Schema.Struct({ memoryId: OptMemoryId });
export interface OptMemoryReadInput extends Schema.Schema.Type<typeof OptMemoryReadInput> {}

export const OptMemoryZoomInput = Schema.Struct({
  ...OptMemoryReadInput.fields,
  range: OptMemoryRange,
  // Pagination applies to originals, not branch expansion.
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxChars: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8_000 }))),
});
export interface OptMemoryZoomInput extends Schema.Schema.Type<typeof OptMemoryZoomInput> {}

export const OptMemoryZoom = Schema.TaggedUnion({
  Branch: { children: Schema.Array(OptMemoryLine) },
  Original: {
    sourceId: Schema.String,
    text: Schema.String,
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    totalChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    nextOffset: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  },
});
export type OptMemoryZoom = typeof OptMemoryZoom.Type;

/** An intentional durable note, not a mirrored session transcript. Caller provenance is trusted metadata. */
export const OptMemoryWriteInput = Schema.Struct({
  memoryId: OptMemoryId,
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  sourceSessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
});
export interface OptMemoryWriteInput extends Schema.Schema.Type<typeof OptMemoryWriteInput> {}

export const OptMemoryWriteResult = Schema.Struct({ sourceId: Schema.String });
export interface OptMemoryWriteResult extends Schema.Schema.Type<typeof OptMemoryWriteResult> {}

export class OptMemoryError extends Schema.TaggedError<OptMemoryError>()("OptMemoryError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
