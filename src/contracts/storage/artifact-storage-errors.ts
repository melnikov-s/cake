import { Schema } from "effect";

export class ArtifactStorageError extends Schema.TaggedError<ArtifactStorageError>()(
  "ArtifactStorageError",
  { operation: Schema.String, message: Schema.String },
) {}

export class ArtifactPublicationConflict extends Schema.TaggedError<ArtifactPublicationConflict>()(
  "ArtifactPublicationConflict",
  {
    lineageId: Schema.String,
    expectedLatestRevision: Schema.Int,
    actualLatestRevision: Schema.Int,
  },
) {}
