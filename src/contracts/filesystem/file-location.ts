import { Schema } from "effect";
import { editorLocationSchema } from "../editor/editor-location";

export const PrepareFileLocation = Schema.Struct({
  workspacePath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096))),
  /** Omitted only for global Cake Chat, whose Working Directory is the host home. */
  originatingDirectory: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_096))),
  location: editorLocationSchema,
});
export interface PrepareFileLocation extends Schema.Schema.Type<typeof PrepareFileLocation> {}

export const PreparedFileLocation = Schema.Union([
  Schema.Struct({ viewer: Schema.Literal("vscode"), location: editorLocationSchema }),
  Schema.Struct({
    viewer: Schema.Literal("text"),
    path: Schema.String,
    content: Schema.String.check(Schema.isMaxLength(2_000_000)),
  }),
]);
export type PreparedFileLocation = typeof PreparedFileLocation.Type;
