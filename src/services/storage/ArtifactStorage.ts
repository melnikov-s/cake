import { Context, type Effect } from "effect";
import type { CakeArtifactV1 } from "../../contracts/artifacts/artifact-contract";
import type {
  ArtifactCatalog,
  ArtifactDigest,
  ArtifactLineageId,
  ArtifactLink,
  ArtifactLinkTarget,
  ArtifactRevision,
  ArtifactRevisionNumber,
} from "../../contracts/artifacts/artifact-lineage";
import type {
  ArtifactStorageError,
  ArtifactPublicationConflict,
} from "../../contracts/storage/artifact-storage-errors";

import type {
  ArtifactState,
  ArtifactStateReplacement,
  ArtifactStagedState,
  ArtifactStateConflict,
} from "../../contracts/artifacts/artifact-state";

interface PublishArtifactRevision {
  readonly stagedState?: ArtifactStagedState;
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

interface ResolvedArtifactLink {
  readonly revision: ArtifactRevision;
  readonly link: ArtifactLink;
  readonly latestRevision: ArtifactRevisionNumber;
}

export interface ArtifactStorageService {
  readonly readState: (
    lineageId: ArtifactLineageId,
  ) => Effect.Effect<ArtifactState, ArtifactStorageError>;
  readonly replaceState: (
    input: ArtifactStateReplacement,
  ) => Effect.Effect<ArtifactState, ArtifactStorageError | ArtifactStateConflict>;
  readonly publish: (
    input: PublishArtifactRevision,
  ) => Effect.Effect<
    ArtifactRevision,
    ArtifactStorageError | ArtifactPublicationConflict | ArtifactStateConflict
  >;
  /** Publishes revision one and its initial reachability link in one catalog mutation. */
  readonly publishWithLink: (
    input: PublishArtifactRevision,
    link: ArtifactLink,
  ) => Effect.Effect<
    ArtifactRevision,
    ArtifactStorageError | ArtifactPublicationConflict | ArtifactStateConflict
  >;
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
  /** Select links synchronously and resolve their blobs/metadata from one locked catalog snapshot. */
  readonly resolveLinks: (
    selectLinks: (links: ReadonlyArray<ArtifactLink>) => ReadonlyArray<ArtifactLink>,
  ) => Effect.Effect<ReadonlyArray<ResolvedArtifactLink>, ArtifactStorageError>;
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
