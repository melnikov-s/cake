import { Schema } from "effect";
import { attachmentSchema, thinkingLevelSchema } from "../../ipc/session-contract";

export const SavedDraftConfiguration = Schema.Struct({
  provider: Schema.String,
  modelId: Schema.String,
  thinkingLevel: thinkingLevelSchema,
  fastMode: Schema.Boolean,
});

export const SavedDraft = Schema.Struct({
  sessionId: Schema.String.check(Schema.isUUID(4)),
  projectPath: Schema.String,
  workingDirectory: Schema.String,
  title: Schema.String,
  text: Schema.String,
  attachments: Schema.Array(attachmentSchema),
  configuration: Schema.optionalKey(SavedDraftConfiguration),
  labelIds: Schema.Array(Schema.String),
  resolved: Schema.Boolean,
  createdAt: Schema.String,
  modifiedAt: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  status: Schema.Literals(["saved", "activating", "activated"]),
});
export interface SavedDraft extends Schema.Schema.Type<typeof SavedDraft> {}
