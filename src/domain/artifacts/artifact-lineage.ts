import { Schema } from "effect";
import {
  artifactKindSchema,
  artifactRecordSchema,
  cakeArtifactV1Schema,
  idSchema,
  type ArtifactRecord,
} from "../../ipc/artifact-contract";

export const ArtifactLineageId = idSchema.pipe(Schema.brand("ArtifactLineageId"));
export type ArtifactLineageId = typeof ArtifactLineageId.Type;

export const ArtifactRevisionNumber = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
).pipe(Schema.brand("ArtifactRevisionNumber"));
export type ArtifactRevisionNumber = typeof ArtifactRevisionNumber.Type;

export const ArtifactDigest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)).pipe(
  Schema.brand("ArtifactDigest"),
);
export type ArtifactDigest = typeof ArtifactDigest.Type;

const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const BoundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

export const ArtifactLinkTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), sessionId: BoundedId }),
  Schema.Struct({ type: Schema.Literal("family"), familyId: BoundedId }),
]);
export type ArtifactLinkTarget = typeof ArtifactLinkTarget.Type;

const ArtifactLinkSelection = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("follow-latest") }),
  Schema.Struct({ mode: Schema.Literal("pinned"), revision: ArtifactRevisionNumber }),
]);
export const ArtifactLink = Schema.Struct({
  lineageId: ArtifactLineageId,
  target: ArtifactLinkTarget,
  selection: ArtifactLinkSelection,
  createdAt: Schema.String,
});
export interface ArtifactLink extends Schema.Schema.Type<typeof ArtifactLink> {}

export const ArtifactRevisionMetadata = Schema.Struct({
  revision: ArtifactRevisionNumber,
  digest: ArtifactDigest,
  kind: Schema.Union([artifactKindSchema, Schema.Literal("architecture")]),
  publishedAt: Schema.String,
  publishedBySessionId: BoundedId,
  workingDirectory: BoundedPath,
  restoredFromRevision: Schema.optionalKey(ArtifactRevisionNumber),
});
export interface ArtifactRevisionMetadata extends Schema.Schema.Type<
  typeof ArtifactRevisionMetadata
> {}

export const ArtifactLineage = Schema.Struct({
  id: ArtifactLineageId,
  createdAt: Schema.String,
  latestRevision: ArtifactRevisionNumber,
  revisions: Schema.Array(ArtifactRevisionMetadata).check(Schema.isMinLength(1)),
});
export interface ArtifactLineage extends Schema.Schema.Type<typeof ArtifactLineage> {}

export const ArtifactCatalog = Schema.Struct({
  lineages: Schema.Array(ArtifactLineage),
  links: Schema.Array(ArtifactLink),
});
export interface ArtifactCatalog extends Schema.Schema.Type<typeof ArtifactCatalog> {}

export const ArtifactRevision = Schema.Struct({
  lineageId: ArtifactLineageId,
  metadata: ArtifactRevisionMetadata,
  snapshot: cakeArtifactV1Schema,
});
export interface ArtifactRevision extends Schema.Schema.Type<typeof ArtifactRevision> {}

export const ArtifactStableRef = Schema.String.check(
  Schema.isPattern(/^cake:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._:-]*(?:@r[1-9][0-9]*)?$/),
);
export type ArtifactStableRef = typeof ArtifactStableRef.Type;

export interface ParsedArtifactRef {
  readonly lineageId: ArtifactLineageId;
  readonly revision?: ArtifactRevisionNumber;
}

export const formatArtifactRef = (reference: ParsedArtifactRef): ArtifactStableRef =>
  Schema.decodeUnknownSync(ArtifactStableRef)(
    `cake://artifact/${reference.lineageId}${reference.revision === undefined ? "" : `@r${reference.revision}`}`,
  );

export const artifactRevisionToRecord = (revision: ArtifactRevision): ArtifactRecord =>
  Schema.decodeUnknownSync(artifactRecordSchema)({
    artifact: revision.snapshot,
    workspacePath: revision.metadata.workingDirectory,
    digest: revision.metadata.digest,
    createdAt: revision.metadata.publishedAt,
    updatedAt: revision.metadata.publishedAt,
  });

export const parseArtifactRef = (reference: string): ParsedArtifactRef => {
  const value = Schema.decodeUnknownSync(ArtifactStableRef)(reference);
  const match = /^cake:\/\/artifact\/([A-Za-z0-9][A-Za-z0-9._:-]*)(?:@r([1-9][0-9]*))?$/.exec(
    value,
  );
  if (!match) throw new Error("Invalid artifact reference");
  const lineageId = Schema.decodeUnknownSync(ArtifactLineageId)(match[1]);
  return match[2] === undefined
    ? { lineageId }
    : {
        lineageId,
        revision: Schema.decodeUnknownSync(ArtifactRevisionNumber)(Number(match[2])),
      };
};
