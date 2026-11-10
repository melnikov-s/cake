import { Schema } from "effect";

// Keep the persisted v1 identifiers unchanged: existing Pi trees use these keys.
// They are storage compatibility, not public command aliases or display names.
/** Hidden orientation metadata on a tool-pruned Pi branch. */
export const toolPruneEntryType = "cake.tool-compact/v1";
/** Hidden Cake provenance. Plain Pi custom entries never participate in model context. */
export const toolPruneProvenanceEntryType = "cake.tool-compact-provenance/v1";

const entryIdSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const toolPruneMarkerSchema = Schema.Struct({
  summary: Schema.String,
  // Absent when the source branch has no canonical system declaration.
  systemCheckpointEntryId: Schema.optionalKey(entryIdSchema),
});

export interface ToolPruneMarker extends Schema.Schema.Type<typeof toolPruneMarkerSchema> {}

const toolPruneReplayMappingSchema = Schema.Struct({
  sourceEntryId: entryIdSchema,
  replayedEntryId: entryIdSchema,
});

export const toolPruneProvenanceSchema = Schema.Struct({
  version: Schema.Literal(1),
  sourceLeafId: entryIdSchema,
  markerEntryId: entryIdSchema,
  replayStartEntryId: entryIdSchema,
  replayEndEntryId: entryIdSchema,
  mappings: Schema.Array(toolPruneReplayMappingSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(50_000),
  ),
});

export interface ToolPruneProvenance extends Schema.Schema.Type<typeof toolPruneProvenanceSchema> {}
