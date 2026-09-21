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

/** Classifies a user-facing path while keeping project source locations Working Directory-relative. */
export function editorLocationFromPath(location: SourceLocation): EditorLocation {
  const path = location.path.trim();
  const absolute = path.startsWith("/") || /^[a-z]:[\\/]/i.test(path) || path.startsWith("\\\\");
  return { ...location, kind: absolute ? "absolute-file" : "working-directory", path };
}

export function workingDirectoryEditorLocation(location: SourceLocation): EditorLocation {
  return { ...location, kind: "working-directory" };
}
