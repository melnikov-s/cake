import { Schema } from "effect";
import { sourceLocationSchema, type SourceLocation } from "./source-location";

const workingDirectoryEditorLocationSchema = Schema.Struct({
  kind: Schema.Literal("working-directory"),
  ...sourceLocationSchema.fields,
});

const absoluteFileEditorLocationSchema = Schema.Struct({
  kind: Schema.Literal("absolute-file"),
  path: sourceLocationSchema.fields.path,
  range: sourceLocationSchema.fields.range,
  ranges: sourceLocationSchema.fields.ranges,
  symbol: sourceLocationSchema.fields.symbol,
  documentVersion: sourceLocationSchema.fields.documentVersion,
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
