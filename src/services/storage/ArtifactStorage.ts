import { Context, Schema, type Effect } from "effect";
import type { CakeArtifactV1 } from "../../ipc/artifact-contract";
import type {
  ArtifactCatalog,
  ArtifactDigest,
  ArtifactLineageId,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevision,
  ArtifactRevisionNumber,
} from "../../domain/artifacts/artifact-lineage";

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

interface PublishArtifactRevision {
  readonly lineageId: ArtifactLineageId;
  readonly expectedLatestRevision: number;
  readonly snapshot: CakeArtifactV1;
  readonly workingDirectory: string;
  readonly restoredFromRevision?: ArtifactRevisionNumber;
}

interface ArtifactCatalogSnapshot {
  readonly catalog: ArtifactCatalog;
  readonly token: string;
}

export interface ArtifactCollectionInput {
  readonly expectedCatalogToken: string;
  readonly survivingSessionIds: ReadonlyArray<string>;
  readonly survivingFamilyIds: ReadonlyArray<string>;
  readonly transcriptLineageIds: ReadonlyArray<ArtifactLineageId>;
}

interface ArtifactCollectionStats {
  readonly skipped: boolean;
  readonly lineagesRemoved: number;
  readonly revisionsRemoved: number;
  readonly linksRemoved: number;
  readonly blobsRemoved: number;
}

export interface ArtifactStorageService {
  readonly publish: (
    input: PublishArtifactRevision,
  ) => Effect.Effect<ArtifactRevision, ArtifactStorageError | ArtifactPublicationConflict>;
  /** Publishes revision one and its initial reachability link in one catalog mutation. */
  readonly publishWithLink: (
    input: PublishArtifactRevision,
    link: ArtifactLink,
  ) => Effect.Effect<ArtifactRevision, ArtifactStorageError | ArtifactPublicationConflict>;
  readonly read: (
    lineageId: ArtifactLineageId,
    revision?: ArtifactRevisionNumber,
  ) => Effect.Effect<ArtifactRevision | undefined, ArtifactStorageError>;
  readonly listRevisions: (
    lineageId: ArtifactLineageId,
  ) => Effect.Effect<ReadonlyArray<ArtifactRevision>, ArtifactStorageError>;
  readonly putLink: (link: ArtifactLink) => Effect.Effect<void, ArtifactStorageError>;
  readonly removeLink: (
    target: ArtifactLinkTarget,
    lineageId: ArtifactLineageId,
  ) => Effect.Effect<void, ArtifactStorageError>;
  readonly resolveLinks: (
    target: ArtifactLinkTarget,
  ) => Effect.Effect<ReadonlyArray<ArtifactRevision>, ArtifactStorageError>;
  readonly removeTargetLinks: (
    target: ArtifactLinkTarget,
  ) => Effect.Effect<void, ArtifactStorageError>;
  readonly catalog: () => Effect.Effect<ArtifactCatalog, ArtifactStorageError>;
  readonly collectionSnapshot: () => Effect.Effect<ArtifactCatalogSnapshot, ArtifactStorageError>;
  /** Atomically drops metadata only when the catalog still matches the verified snapshot. */
  readonly collectUnreachable: (
    input: ArtifactCollectionInput,
  ) => Effect.Effect<ArtifactCollectionStats, ArtifactStorageError>;
  readonly deleteBlobIfOrphaned: (
    digest: ArtifactDigest,
  ) => Effect.Effect<boolean, ArtifactStorageError>;
}

export class ArtifactStorage extends Context.Service<ArtifactStorage, ArtifactStorageService>()(
  "cake/services/storage/ArtifactStorage",
) {}
