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
) {
  override get message() {
    return this.expectedLatestRevision === 0
      ? `Artifact "${this.lineageId}" already exists at revision ${this.actualLatestRevision}. Choose a new id, or publish revision ${this.actualLatestRevision + 1} of the existing artifact.`
      : `Artifact "${this.lineageId}" is at revision ${this.actualLatestRevision}, not ${this.expectedLatestRevision}. Read the latest revision and retry.`;
  }
}
