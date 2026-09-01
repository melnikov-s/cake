import { Context, Schema, type Effect } from "effect";
import type { ArtifactRecord, CakeArtifactV1 } from "../../ipc/artifact-contract";

export class ArtifactStorageError extends Schema.TaggedError<ArtifactStorageError>()(
  "ArtifactStorageError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface ArtifactStorageService {
  readonly upsert: (
    workingDirectory: string,
    artifact: CakeArtifactV1,
  ) => Effect.Effect<ArtifactRecord, ArtifactStorageError>;
  readonly get: (
    workingDirectory: string,
    sessionId: string,
    artifactId: string,
  ) => Effect.Effect<ArtifactRecord | undefined, ArtifactStorageError>;
  readonly listSession: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<ReadonlyArray<ArtifactRecord>, ArtifactStorageError>;
  readonly linkSession: (
    record: ArtifactRecord,
    sessionId: string,
  ) => Effect.Effect<void, ArtifactStorageError>;
  readonly deleteSession: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<void, ArtifactStorageError>;
  readonly exportMarkdown: (
    workingDirectory: string,
    sessionId: string,
  ) => Effect.Effect<string, ArtifactStorageError>;
}

export class ArtifactStorage extends Context.Service<ArtifactStorage, ArtifactStorageService>()(
  "cake/services/storage/ArtifactStorage",
) {}
