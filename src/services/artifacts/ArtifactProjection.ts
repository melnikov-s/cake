import { Context, Schema, type Effect } from "effect";
import type {
  ArtifactLineageId,
  ArtifactRevision,
  ArtifactRevisionNumber,
} from "../../domain/artifacts/artifact-lineage";

const ArtifactProjectionLinkMode = Schema.Literals(["follow-latest", "pinned"]);
type ArtifactProjectionLinkMode = typeof ArtifactProjectionLinkMode.Type;

export const ArtifactProjectionFile = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  byteSize: Schema.Int,
  sha256: Schema.String,
});
export interface ArtifactProjectionFile extends Schema.Schema.Type<typeof ArtifactProjectionFile> {}

export const ArtifactProjectionMetadata = Schema.Struct({
  lineageId: Schema.String,
  title: Schema.optionalKey(Schema.String),
  kind: Schema.String,
  selectedRevision: Schema.Int,
  latestRevision: Schema.Int,
  digest: Schema.String,
  linkMode: ArtifactProjectionLinkMode,
  stableRef: Schema.String,
  exactRef: Schema.String,
  exactPath: Schema.String,
  latestPath: Schema.optionalKey(Schema.String),
  files: Schema.Array(ArtifactProjectionFile),
});
export interface ArtifactProjectionMetadata extends Schema.Schema.Type<
  typeof ArtifactProjectionMetadata
> {}

export class ArtifactProjectionError extends Schema.TaggedError<ArtifactProjectionError>()(
  "ArtifactProjectionError",
  { operation: Schema.String, message: Schema.String },
) {}

export interface MaterializeArtifactProjectionInput {
  readonly sessionId: string;
  readonly revision: ArtifactRevision;
  readonly latestRevision: ArtifactRevisionNumber;
  readonly linkMode: ArtifactProjectionLinkMode;
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
  }
>()("cake/services/artifacts/ArtifactProjection") {}
