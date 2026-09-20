import { Schema } from "effect";

/** Visible orientation marker on a tool-compacted Pi branch. */
export const toolCompactEntryType = "cake.tool-compact/v1";
/** Hidden Cake provenance. Plain Pi custom entries never participate in model context. */
export const toolCompactProvenanceEntryType = "cake.tool-compact-provenance/v1";

const entryIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

const toolCompactReplayMappingSchema = Schema.Struct({
  sourceEntryId: entryIdSchema,
  replayedEntryId: entryIdSchema,
});

export const toolCompactProvenanceSchema = Schema.Struct({
  version: Schema.Literal(1),
  sourceLeafId: entryIdSchema,
  markerEntryId: entryIdSchema,
  replayStartEntryId: entryIdSchema,
  replayEndEntryId: entryIdSchema,
  mappings: Schema.Array(toolCompactReplayMappingSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50_000),
  ),
});

export interface ToolCompactProvenance extends Schema.Schema.Type<
  typeof toolCompactProvenanceSchema
> {}
