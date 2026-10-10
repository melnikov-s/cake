import { Schema } from "effect";

export const ArtifactProjectionLinkMode = Schema.Literals(["follow-latest", "pinned"]);

export type ArtifactProjectionLinkMode = typeof ArtifactProjectionLinkMode.Type;

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
