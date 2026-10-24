import { Schema } from "effect";

const VisibleEditorMetadata = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4096)),
  group: Schema.optionalKey(Schema.Number),
  active: Schema.Boolean,
});
export const VisibleEditorMetadataList = Schema.Array(VisibleEditorMetadata).check(
  Schema.isMaxLength(32),
);

/** Metadata only: never editor contents, browser credentials, or a directory listing. */
export const AppWorkspaceView = Schema.Struct({
  kind: Schema.Literals(["browser", "vscode"]),
  sessionId: Schema.String,
  paneId: Schema.optionalKey(Schema.String),
  status: Schema.Literals(["ready", "loading", "hidden", "unavailable"]),
  /** Credential-free location; query and fragment are deliberately omitted. */
  url: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  editors: Schema.optionalKey(VisibleEditorMetadataList),
});
export interface AppWorkspaceView extends Schema.Schema.Type<typeof AppWorkspaceView> {}
