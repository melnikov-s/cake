import { Schema } from "effect";

export class ArtifactError extends Schema.TaggedError<ArtifactError>()("ArtifactError", {
  operation: Schema.String,
  message: Schema.String,
}) {}
