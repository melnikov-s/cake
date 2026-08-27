import { z } from "zod";
import { sourceLocationSchema, sourceRangeSchema } from "./source-location";

const editorAnnotationStatusSchema = z.enum(["open", "pending", "answered", "resolved"]);

/** A session-owned Cake discussion projected at a VS Code source location. */
const editorAnnotationSchema = z.object({
  id: z.string().min(1).max(256),
  location: sourceLocationSchema.extend({ range: sourceRangeSchema }),
  status: editorAnnotationStatusSchema,
  replyCount: z.number().int().nonnegative().max(50_000),
  preview: z.string().max(512),
});

/** Complete replacement snapshot for the active project session. */
export const editorAnnotationSnapshotSchema = z.object({
  sessionId: z.string().min(1).max(256),
  annotations: z.array(editorAnnotationSchema).max(10_000),
});

export type EditorAnnotationStatus = z.infer<typeof editorAnnotationStatusSchema>;
export type EditorAnnotation = z.infer<typeof editorAnnotationSchema>;
export type EditorAnnotationSnapshot = z.infer<typeof editorAnnotationSnapshotSchema>;
