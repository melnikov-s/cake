import { Schema } from "effect";
import { sourceLocationSchema, type SourceLocation } from "./source-location";

const editorPresentationFields = {
  group: Schema.optionalKey(
    Schema.Literals([
      "active",
      "beside",
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ]),
  ),
  preview: Schema.optionalKey(Schema.Boolean),
  preserveFocus: Schema.optionalKey(Schema.Boolean),
};

const workingDirectoryEditorLocationSchema = Schema.Struct({
  kind: Schema.Literal("working-directory"),
  ...sourceLocationSchema.fields,
  ...editorPresentationFields,
});

const absoluteFileEditorLocationSchema = Schema.Struct({
  kind: Schema.Literal("absolute-file"),
  path: sourceLocationSchema.fields.path,
  range: sourceLocationSchema.fields.range,
  ranges: sourceLocationSchema.fields.ranges,
  symbol: sourceLocationSchema.fields.symbol,
  documentVersion: sourceLocationSchema.fields.documentVersion,
  ...editorPresentationFields,
});

/** A file that embedded VS Code can open without changing the session's Working Directory. */
export const editorLocationSchema = Schema.Union([
  workingDirectoryEditorLocationSchema,
  absoluteFileEditorLocationSchema,
]);

export type EditorLocation = typeof editorLocationSchema.Type;

/**
 * How embedded VS Code actually presented a revealed location. A `changes`
 * request degrades to `file` when the target does not differ from the base
 * revision, the base cannot be resolved, or the Git extension could not answer
 * in time; `fallback` says which.
 */
export const editorRevealOutcomeSchema = Schema.Struct({
  view: Schema.Literals(["changes", "file"]),
  fallback: Schema.optionalKey(Schema.Literals(["no-changes", "unknown-base", "git-unavailable"])),
});

/** Classifies a user-facing path while keeping project source locations Working Directory-relative. */
export function editorLocationFromPath(location: SourceLocation): EditorLocation {
  const path = location.path.trim();
  const absolute = path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
  return { ...location, kind: absolute ? "absolute-file" : "working-directory", path };
}

export function workingDirectoryEditorLocation(location: SourceLocation): EditorLocation {
  return { ...location, kind: "working-directory" };
}
