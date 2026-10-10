import { Context, type Effect } from "effect";
import type {
  ArtifactLineageId,
  ArtifactRevision,
  ArtifactRevisionNumber,
} from "../../contracts/artifacts/artifact-lineage";
import type {
  ArtifactProjectionError,
  ArtifactProjectionMetadata,
  ArtifactProjectionLinkMode,
} from "../../contracts/artifacts/artifact-projection-data";

export interface MaterializeArtifactProjectionInput {
  readonly sessionId: string;
  readonly revision: ArtifactRevision;
  readonly latestRevision: ArtifactRevisionNumber;
  readonly linkMode: ArtifactProjectionLinkMode;
}

export interface ArtifactProjectionCleanupStats {
  readonly sessionsRemoved: number;
  readonly lineagesRemoved: number;
}

export class ArtifactProjection extends Context.Service<
  ArtifactProjection,
  {
    readonly materialize: (
      input: MaterializeArtifactProjectionInput,
    ) => Effect.Effect<ArtifactProjectionMetadata, ArtifactProjectionError>;
    /** Deletes only disposable derived files for one session, never artifact storage. */
    readonly cleanupSession: (sessionId: string) => Effect.Effect<void, ArtifactProjectionError>;
    /** Deletes only disposable derived files for one linked lineage in one session. */
    readonly cleanupLineage: (
      sessionId: string,
      lineageId: ArtifactLineageId,
    ) => Effect.Effect<void, ArtifactProjectionError>;
    /** Reconciles disposable caches against authoritative surviving identities. */
    readonly cleanup: (input: {
      readonly retained: ReadonlyArray<{
        readonly sessionId: string;
        readonly lineageIds: ReadonlyArray<ArtifactLineageId>;
      }>;
    }) => Effect.Effect<ArtifactProjectionCleanupStats, ArtifactProjectionError>;
  }
>()("cake/services/artifacts/ArtifactProjection") {}
