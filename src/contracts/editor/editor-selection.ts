import { Schema } from "effect";
import { editorRevealOutcomeSchema } from "./editor-location";
import { gitRevisionSchema, sourceLocationSchema, sourceRangeSchema } from "./source-location";

export const EditorSelectionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("EditorSelectionId"));
export type EditorSelectionId = typeof EditorSelectionId.Type;

const locationFields = {
  path: sourceLocationSchema.fields.path,
  range: sourceRangeSchema,
};

/** One resolved range, never an editor instance. Coordinates are zero-based. */
export const EditorSelectionLocation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("working-directory"),
    view: Schema.Literal("file"),
    ...locationFields,
  }),
  Schema.Struct({
    kind: Schema.Literal("working-directory"),
    ...locationFields,
    view: Schema.Literal("changes"),
    side: Schema.Literals(["before", "after"]),
    base: gitRevisionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("absolute-file"),
    view: Schema.Literal("file"),
    ...locationFields,
  }),
]);
export type EditorSelectionLocation = typeof EditorSelectionLocation.Type;

/** Native rendering instructions only. An empty list clears all tour highlights. */
export const EditorSelectionHighlights = Schema.Struct({
  locations: Schema.Array(EditorSelectionLocation),
});
export interface EditorSelectionHighlights extends Schema.Schema.Type<
  typeof EditorSelectionHighlights
> {}

/** IDs are allocated and owned by the session's EditorSelectionsStore. */
export const EditorSelection = Schema.Struct({
  id: EditorSelectionId,
  location: EditorSelectionLocation,
});
export interface EditorSelection extends Schema.Schema.Type<typeof EditorSelection> {}

/**
 * A copy of ephemeral Store state for agent replies only, never native rendering.
 * Selection IDs and session identity stay out of the VS Code highlight payload.
 * Not a main-owned record, persisted snapshot, or independently mutable mirror.
 */
export const EditorSelectionState = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  selections: Schema.Array(EditorSelection),
});
export interface EditorSelectionState extends Schema.Schema.Type<typeof EditorSelectionState> {}

/**
 * Companion reveal response. Resolve/clamp ranges (including symbols),
 * but do not register selections. File-only navigation returns no locations.
 */
export const EditorSelectionReveal = Schema.Struct({
  outcome: editorRevealOutcomeSchema,
  locations: Schema.Array(EditorSelectionLocation),
});
export interface EditorSelectionReveal extends Schema.Schema.Type<typeof EditorSelectionReveal> {}

/** Store mutations remain effective if rendering fails; surface that warning. */
export const EditorSelectionUpdate = Schema.Struct({
  state: EditorSelectionState,
  warning: Schema.optionalKey(Schema.String),
});
export interface EditorSelectionUpdate extends Schema.Schema.Type<typeof EditorSelectionUpdate> {}

/** Ranged open adds/reuses IDs in the Store; plain file open returns an empty array. */
export const EditorSelectionOpenResult = Schema.Struct({
  reveal: EditorSelectionReveal,
  selectionIds: Schema.Array(EditorSelectionId),
  warning: Schema.optionalKey(Schema.String),
});
export interface EditorSelectionOpenResult extends Schema.Schema.Type<
  typeof EditorSelectionOpenResult
> {}
