import { createHash } from "node:crypto";
import { Effect, Schema } from "effect";
import {
  ArtifactCatalog,
  ArtifactLineageId,
  ArtifactRevisionNumber,
  ArtifactRevisionMetadata,
  type ArtifactLinkTarget,
  type ArtifactLink,
} from "../../contracts/artifacts/artifact-lineage";
import { ArtifactState } from "../../contracts/artifacts/artifact-state";
import {
  cakeArtifactV1Schema,
  parseArtifactInput,
  type CakeArtifactV1,
} from "../../contracts/artifacts/artifact-contract";
import { ArtifactStorageError } from "../../contracts/storage/artifact-storage-errors";

export const CATALOG_VERSION = 5;
// Catalog migration reads identity/title only, never interprets historical payloads.
export const StoredArtifactHeader = Schema.Struct({
  protocol: Schema.Literal("cake.artifact/v1"),
  id: ArtifactLineageId,
  revision: ArtifactRevisionNumber,
  title: ArtifactRevisionMetadata.fields.title,
});
const CatalogEnvelope = Schema.Struct({ version: Schema.Int, data: Schema.Unknown });
const CurrentCatalogData = Schema.Struct({
  ...ArtifactCatalog.fields,
  states: Schema.Array(ArtifactState),
});
const LegacyLineage = Schema.Struct({
  id: ArtifactLineageId,
  createdAt: Schema.String,
  latestRevision: ArtifactRevisionNumber,
  revisions: Schema.Array(ArtifactRevisionMetadata).check(Schema.isMinLength(1)),
});
const LegacyCatalog = Schema.Struct({
  lineages: Schema.Array(LegacyLineage),
  links: ArtifactCatalog.fields.links,
});
const LegacyStateCatalog = Schema.Struct({
  ...LegacyCatalog.fields,
  states: Schema.Array(ArtifactState),
});
const LegacyCatalogV1 = Schema.Struct({
  lineages: LegacyCatalog.fields.lineages,
  links: Schema.Array(
    Schema.Struct({
      lineageId: ArtifactLineageId,
      sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      revision: ArtifactRevisionNumber,
      createdAt: Schema.String,
    }),
  ),
});

const HistoricalArchitecture = Schema.Struct({
  protocol: Schema.Literal("cake.artifact/v1"),
  id: Schema.String,
  sessionId: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.Literal("architecture"),
  title: Schema.optional(Schema.String),
  payload: Schema.Unknown,
  fallback: Schema.Struct({ markdown: Schema.String }),
  interaction: Schema.optional(Schema.Unknown),
});

type StoredKind = ArtifactRevisionMetadata["kind"];
export interface DecodedBlob {
  readonly snapshot: CakeArtifactV1;
  readonly storedKind: StoredKind;
}

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export const targetKey = (target: ArtifactLinkTarget) =>
  target.type === "session" ? `session:${target.sessionId}` : `family:${target.familyId}`;
export const linkKey = (link: ArtifactLink) => `${targetKey(link.target)}\u0000${link.lineageId}`;

export const storageError = (operation: string, cause: unknown) =>
  new ArtifactStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const StoredBlob = Schema.Union([HistoricalArchitecture, cakeArtifactV1Schema]);

export const decodeBlob = Effect.fn("ArtifactStorage.decodeBlob")(function* (
  serialized: string,
): Effect.fn.Return<DecodedBlob, ArtifactStorageError> {
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredBlob))(
    serialized,
  ).pipe(Effect.mapError((cause) => storageError("decodeBlob", cause)));
  if (value.kind === "architecture") {
    const snapshot = yield* Effect.try({
      try: () =>
        parseArtifactInput({
          protocol: value.protocol,
          id: value.id,
          sessionId: value.sessionId,
          revision: value.revision,
          kind: "markdown",
          title: value.title,
          payload: { markdown: value.fallback.markdown },
          fallback: value.fallback,
          interaction: { mode: "present" },
        }),
      catch: (cause) => storageError("decodeBlob", cause),
    });
    return { snapshot, storedKind: "architecture" };
  }
  return { snapshot: value, storedKind: value.kind };
});

export const validateCatalog = (catalog: ArtifactCatalog): ArtifactCatalog => {
  const lineageIds = new Set<string>();
  const links = new Set<string>();
  for (const lineage of catalog.lineages) {
    if (lineageIds.has(lineage.id)) throw new Error(`Duplicate artifact lineage ${lineage.id}`);
    lineageIds.add(lineage.id);
    lineage.revisions.forEach((revision, index) => {
      if (revision.revision !== index + 1)
        throw new Error(`Artifact ${lineage.id} has a non-contiguous revision index`);
      if (
        revision.restoredFromRevision !== undefined &&
        revision.restoredFromRevision >= revision.revision
      )
        throw new Error(`Artifact ${lineage.id} restore metadata must reference an older revision`);
    });
    if (lineage.latestRevision !== lineage.revisions.length)
      throw new Error(`Artifact ${lineage.id} latest revision does not match its revision index`);
  }
  for (const link of catalog.links) {
    const key = linkKey(link);
    if (links.has(key)) throw new Error(`Duplicate artifact link ${key}`);
    links.add(key);
    const lineage = catalog.lineages.find((candidate) => candidate.id === link.lineageId);
    if (!lineage) throw new Error(`Artifact link references missing lineage ${link.lineageId}`);
    const selection = link.selection;
    if (
      selection.mode === "pinned" &&
      !lineage.revisions.some((item) => item.revision === selection.revision)
    )
      throw new Error(
        `Artifact link pins missing revision ${link.lineageId}@r${selection.revision}`,
      );
  }
  return catalog;
};

export const decodeCatalog = Effect.fn("ArtifactStorage.decodeCatalog")(function* (
  serialized: string,
) {
  const envelope = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogEnvelope))(
    serialized,
  ).pipe(Effect.mapError((cause) => storageError("load", cause)));
  let current: ArtifactCatalog;
  let currentStates: ReadonlyArray<ArtifactState> = [];
  if (envelope.version === 1) {
    const legacy = yield* Schema.decodeUnknownEffect(LegacyCatalogV1)(envelope.data).pipe(
      Effect.mapError((cause) => storageError("migrate", cause)),
    );
    current = {
      lineages: legacy.lineages.map((lineage) => ({ ...lineage, global: false })),
      links: legacy.links.map((link) => ({
        lineageId: link.lineageId,
        target: { type: "session", sessionId: link.sessionId },
        selection: { mode: "pinned", revision: link.revision },
        createdAt: link.createdAt,
      })),
    };
  } else if (envelope.version === 2) {
    const legacy = yield* Schema.decodeUnknownEffect(LegacyCatalog)(envelope.data).pipe(
      Effect.mapError((cause) => storageError("load", cause)),
    );
    current = {
      lineages: legacy.lineages.map((lineage) => ({ ...lineage, global: false })),
      links: legacy.links,
    };
  } else if (
    envelope.version === 3 ||
    envelope.version === 4 ||
    envelope.version === CATALOG_VERSION
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(
      envelope.version === CATALOG_VERSION ? CurrentCatalogData : LegacyStateCatalog,
    )(envelope.data).pipe(Effect.mapError((cause) => storageError("load", cause)));
    current = {
      lineages: decoded.lineages.map((lineage) => ({ global: false, ...lineage })),
      links: decoded.links,
    };
    currentStates = decoded.states;
    if (
      new Set(currentStates.map((state) => state.lineageId)).size !== currentStates.length ||
      currentStates.some(
        (state) => !current.lineages.some((lineage) => lineage.id === state.lineageId),
      )
    )
      return yield* storageError("load", "Invalid artifact current-state collection");
  } else {
    return yield* storageError("load", `Unsupported artifact catalog version ${envelope.version}`);
  }

  return { catalog: current, states: currentStates, version: envelope.version };
});
