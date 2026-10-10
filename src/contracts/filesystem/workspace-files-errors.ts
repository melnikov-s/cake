import { Schema } from "effect";

export class WorkspaceFileError extends Schema.TaggedError<WorkspaceFileError>()(
  "WorkspaceFileError",
  { operation: Schema.String, message: Schema.String },
) {}
