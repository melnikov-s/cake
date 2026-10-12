import { Schema } from "effect";
import { sourceLocationSchema, sourceRangeSchema } from "./source-location";

const editorAnnotationStatusSchema = Schema.Literals(["open", "pending", "answered", "resolved"]);

/** A session-owned Cake discussion projected at a VS Code source location. */
const editorAnnotationSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  location: sourceLocationSchema.pipe(Schema.fieldsAssign({ range: sourceRangeSchema })),
  status: editorAnnotationStatusSchema,
  replyCount: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(50_000),
  ),
  preview: Schema.String.check(Schema.isMaxLength(512)),
});

/** Complete replacement snapshot for the active project session. */
export const editorAnnotationSnapshotSchema = Schema.Struct({
  sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  annotations: Schema.Array(editorAnnotationSchema).check(Schema.isMaxLength(10_000)),
});

export type EditorAnnotationStatus = typeof editorAnnotationStatusSchema.Type;
export type EditorAnnotation = typeof editorAnnotationSchema.Type;
export type EditorAnnotationSnapshot = typeof editorAnnotationSnapshotSchema.Type;
