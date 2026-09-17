import { createHash } from "node:crypto";
import { DateTime, Effect, FileSystem, Layer, Path, Schema, Semaphore } from "effect";
import {
  ArtifactCatalog,
  ArtifactDigest,
  ArtifactLineageId,
  ArtifactLink,
  ArtifactRevision,
  ArtifactRevisionNumber,
  type ArtifactLineage,
  type ArtifactLinkTarget,
  type ArtifactRevisionMetadata,
} from "../../domain/artifacts/artifact-lineage";
import {
  cakeArtifactV1Schema,
  parseArtifactInput,
  type CakeArtifactV1,
} from "../../ipc/artifact-contract";
import {
  ArtifactPublicationConflict,
  ArtifactStorage,
  ArtifactStorageError,
} from "./ArtifactStorage";
import { atomicWriteFile } from "./internal/atomicFile";

const CATALOG_VERSION = 2;
const CatalogEnvelope = Schema.Struct({ version: Schema.Int, data: Schema.Unknown });
const LegacyCatalogV1 = Schema.Struct({
  lineages: ArtifactCatalog.fields.lineages,
  links: Schema.Array(
    Schema.Struct({
      lineageId: ArtifactLineageId,
      sessionId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
      revision: ArtifactRevisionNumber,
      createdAt: Schema.String,
    }),
  ),
});

const LegacyMetadata = Schema.Struct({
  protocol: Schema.Literal("cake.artifact/v1"),
  id: Schema.String,
  sessionId: Schema.String,
  workspacePath: Schema.String,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  kind: Schema.String,
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  targetSessionId: Schema.optionalKey(Schema.String),
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
interface DecodedBlob {
  readonly snapshot: CakeArtifactV1;
  readonly storedKind: StoredKind;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const targetKey = (target: ArtifactLinkTarget) =>
  target.type === "session" ? `session:${target.sessionId}` : `family:${target.familyId}`;
const linkKey = (link: ArtifactLink) => `${targetKey(link.target)}\u0000${link.lineageId}`;
const sourceKey = (sessionId: string, artifactId: string) => `${sessionId}\u0000${artifactId}`;

const storageError = (operation: string, cause: unknown) =>
  new ArtifactStorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
  });

const StoredBlob = Schema.Union([HistoricalArchitecture, cakeArtifactV1Schema]);

const decodeBlob = Effect.fn("ArtifactStorage.decodeBlob")(function* (
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

const validateCatalog = (catalog: ArtifactCatalog): ArtifactCatalog => {
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

export const makeArtifactStorageLive = (root: string) =>
  Layer.effect(
    ArtifactStorage,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = yield* Semaphore.make(1);
      const catalogPath = path.join(root, "catalog.json");
      const blobDirectory = path.join(root, "blobs");
      const blobPath = (value: string) => path.join(blobDirectory, `${value}.json`);

      const readText = (operation: string, target: string) =>
        fileSystem
          .readFileString(target)
          .pipe(Effect.mapError((cause) => storageError(operation, cause)));
      const writeText = (operation: string, target: string, content: string) =>
        atomicWriteFile(fileSystem, path, target, content, (stage, cause) =>
          storageError(`${operation}:${stage}`, cause),
        );

      const saveUnlocked = Effect.fn("ArtifactStorage.saveUnlocked")(function* (
        input: ArtifactCatalog,
      ) {
        const catalog = yield* Effect.try({
          try: () => validateCatalog(input),
          catch: (cause) => storageError("save", cause),
        });
        const encoded = yield* Schema.encodeEffect(ArtifactCatalog)(catalog).pipe(
          Effect.mapError((cause) => storageError("save", cause)),
        );
        yield* writeText(
          "save",
          catalogPath,
          `${JSON.stringify({ version: CATALOG_VERSION, data: encoded }, null, 2)}\n`,
        );
      });

      const readFamilySessionIds = Effect.fn("ArtifactStorage.readFamilySessionIds")(function* () {
        const familyPath = path.join(path.dirname(root), "session-families.json");
        if (!(yield* fileSystem.exists(familyPath).pipe(Effect.orElseSucceed(() => false))))
          return [];
        const schema = Schema.Struct({
          version: Schema.Int,
          data: Schema.Struct({
            families: Schema.Array(
              Schema.Struct({
                familyId: Schema.String,
                parentSessionId: Schema.String,
                children: Schema.Array(Schema.Struct({ sessionId: Schema.String })),
              }),
            ),
          }),
        });
        const decoded = yield* readText("migrate", familyPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
          Effect.mapError((cause) => storageError("migrate", cause)),
        );
        return decoded.data.families.flatMap((family) => [
          family.parentSessionId,
          ...family.children.map((child) => child.sessionId),
        ]);
      });

      const migrateLegacyUnlocked = Effect.fn("ArtifactStorage.migrateLegacyUnlocked")(
        function* () {
          const sessionsDirectory = path.join(root, "sessions");
          const hasSessions = yield* fileSystem
            .exists(sessionsDirectory)
            .pipe(Effect.mapError((cause) => storageError("migrate", cause)));
          const hasBlobs = yield* fileSystem
            .exists(blobDirectory)
            .pipe(Effect.mapError((cause) => storageError("migrate", cause)));
          if (!hasSessions && !hasBlobs)
            return { lineages: [], links: [] } satisfies ArtifactCatalog;

          const decodedByDigest = new Map<string, DecodedBlob>();
          if (hasBlobs) {
            const names = yield* fileSystem
              .readDirectory(blobDirectory)
              .pipe(Effect.mapError((cause) => storageError("migrate", cause)));
            yield* Effect.forEach(
              names.filter((name) => name.endsWith(".json")),
              Effect.fn("ArtifactStorage.migrateBlob")(function* (name) {
                const serialized = yield* readText("migrate", path.join(blobDirectory, name));
                const expected = name.slice(0, -5);
                if (digest(serialized) !== expected)
                  return yield* storageError("migrate", `Blob ${name} has an invalid digest`);
                const decoded = yield* decodeBlob(serialized);
                decodedByDigest.set(expected, decoded);
              }),
              { discard: true },
            );
          }

          const metadata: Array<{
            readonly value: typeof LegacyMetadata.Type;
            readonly sessionHash: string;
          }> = [];
          if (hasSessions) {
            const workspaceDirectories = yield* fileSystem
              .readDirectory(sessionsDirectory)
              .pipe(Effect.mapError((cause) => storageError("migrate", cause)));
            yield* Effect.forEach(
              workspaceDirectories,
              Effect.fn("ArtifactStorage.migrateWorkspaceIndex")(function* (workspaceHash) {
                const workspaceDirectory = path.join(sessionsDirectory, workspaceHash);
                const sessionDirectories = yield* fileSystem
                  .readDirectory(workspaceDirectory)
                  .pipe(Effect.mapError((cause) => storageError("migrate", cause)));
                yield* Effect.forEach(
                  sessionDirectories,
                  Effect.fn("ArtifactStorage.migrateSessionIndex")(function* (sessionHash) {
                    const directory = path.join(workspaceDirectory, sessionHash);
                    const names = yield* fileSystem
                      .readDirectory(directory)
                      .pipe(Effect.mapError((cause) => storageError("migrate", cause)));
                    yield* Effect.forEach(
                      names.filter((name) => name.endsWith(".json")),
                      Effect.fn("ArtifactStorage.migrateIndexRecord")(function* (name) {
                        const value = yield* readText("migrate", path.join(directory, name)).pipe(
                          Effect.flatMap(
                            Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyMetadata)),
                          ),
                          Effect.mapError((cause) => storageError("migrate", cause)),
                        );
                        const blob = decodedByDigest.get(value.digest);
                        if (!blob)
                          return yield* storageError(
                            "migrate",
                            `Index for ${value.id} references missing blob ${value.digest}`,
                          );
                        if (
                          blob.snapshot.id !== value.id ||
                          blob.snapshot.sessionId !== value.sessionId ||
                          blob.snapshot.revision !== value.revision ||
                          blob.storedKind !== value.kind
                        )
                          return yield* storageError(
                            "migrate",
                            `Index metadata for ${value.id} does not match its blob`,
                          );
                        metadata.push({ value, sessionHash });
                      }),
                      { discard: true },
                    );
                  }),
                  { discard: true },
                );
              }),
              { discard: true },
            );
          }

          const referencedSources = new Set(
            metadata
              .filter(({ value }) => decodedByDigest.get(value.digest)?.snapshot.kind !== "request")
              .map(({ value }) => sourceKey(value.sessionId, value.id)),
          );
          const blobsBySource = new Map<string, Array<[string, DecodedBlob]>>();
          for (const [blobDigest, blob] of decodedByDigest) {
            if (blob.snapshot.kind === "request") continue;
            const key = sourceKey(blob.snapshot.sessionId, blob.snapshot.id);
            if (!referencedSources.has(key)) continue;
            const items = blobsBySource.get(key) ?? [];
            items.push([blobDigest, blob]);
            blobsBySource.set(key, items);
          }

          const sourceKeys = [...blobsBySource.keys()].sort();
          const usedIds = new Set<string>();
          const lineageIdBySource = new Map<string, ArtifactLineageId>();
          const lineages: ArtifactLineage[] = [];
          for (const key of sourceKeys) {
            const blobs = blobsBySource.get(key) ?? [];
            blobs.sort((left, right) => left[1].snapshot.revision - right[1].snapshot.revision);
            const first = blobs[0];
            if (!first) continue;
            const baseId = first[1].snapshot.id;
            const chosenId = usedIds.has(baseId) ? `${baseId}-${digest(key).slice(0, 12)}` : baseId;
            const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(chosenId).pipe(
              Effect.mapError((cause) => storageError("migrate", cause)),
            );
            usedIds.add(lineageId);
            lineageIdBySource.set(key, lineageId);
            const matchingMetadata = metadata.filter(
              ({ value }) => sourceKey(value.sessionId, value.id) === key,
            );
            const revisions: ArtifactRevisionMetadata[] = [];
            for (const [blobDigest, blob] of blobs) {
              if (blob.snapshot.revision !== revisions.length + 1)
                return yield* storageError(
                  "migrate",
                  `Artifact ${baseId} has a non-contiguous legacy revision history`,
                );
              const index = matchingMetadata.find(
                ({ value }) => value.revision === blob.snapshot.revision,
              )?.value;
              const fallback = matchingMetadata[0]?.value;
              if (!fallback)
                return yield* storageError("migrate", `Artifact ${baseId} has no legacy index`);
              revisions.push({
                revision: yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
                  blob.snapshot.revision,
                ).pipe(Effect.mapError((cause) => storageError("migrate", cause))),
                digest: yield* Schema.decodeUnknownEffect(ArtifactDigest)(blobDigest).pipe(
                  Effect.mapError((cause) => storageError("migrate", cause)),
                ),
                kind: blob.storedKind,
                publishedAt:
                  blob.snapshot.revision === 1
                    ? (index ?? fallback).createdAt
                    : (index ?? fallback).updatedAt,
                publishedBySessionId: blob.snapshot.sessionId,
                workingDirectory: (index ?? fallback).workspacePath,
              });
            }
            const firstRevision = revisions[0];
            const latestRevision = revisions.at(-1);
            if (!firstRevision || !latestRevision)
              return yield* storageError("migrate", `Artifact ${baseId} has no revisions`);
            lineages.push({
              id: lineageId,
              createdAt: firstRevision.publishedAt,
              latestRevision: latestRevision.revision,
              revisions,
            });
          }

          const candidateSessionIds = new Set<string>([
            ...metadata.map(({ value }) => value.sessionId),
            ...(yield* readFamilySessionIds()),
          ]);
          const linksByKey = new Map<string, ArtifactLink>();
          for (const item of metadata) {
            const blob = decodedByDigest.get(item.value.digest);
            if (!blob || blob.snapshot.kind === "request") continue;
            const lineageId = lineageIdBySource.get(sourceKey(item.value.sessionId, item.value.id));
            if (!lineageId) continue;
            const targetSessionId =
              item.value.targetSessionId ??
              [...candidateSessionIds].find((candidate) => digest(candidate) === item.sessionHash);
            if (!targetSessionId)
              return yield* storageError(
                "migrate",
                `Cannot identify legacy session link for artifact ${item.value.id}`,
              );
            const link: ArtifactLink = {
              lineageId,
              target: { type: "session", sessionId: targetSessionId },
              selection:
                targetSessionId === item.value.sessionId
                  ? { mode: "follow-latest" }
                  : {
                      mode: "pinned",
                      revision: yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
                        item.value.revision,
                      ).pipe(Effect.mapError((cause) => storageError("migrate", cause))),
                    },
              createdAt: item.value.createdAt,
            };
            linksByKey.set(linkKey(link), link);
          }
          return validateCatalog({ lineages, links: [...linksByKey.values()] });
        },
      );

      const loadUnlocked = Effect.fn("ArtifactStorage.loadUnlocked")(function* () {
        const exists = yield* fileSystem
          .exists(catalogPath)
          .pipe(Effect.mapError((cause) => storageError("load", cause)));
        if (!exists) {
          const migrated = yield* migrateLegacyUnlocked();
          yield* saveUnlocked(migrated);
          return migrated;
        }
        const envelope = yield* readText("load", catalogPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogEnvelope))),
          Effect.mapError((cause) => storageError("load", cause)),
        );
        let current: ArtifactCatalog;
        if (envelope.version === 1) {
          const legacy = yield* Schema.decodeUnknownEffect(LegacyCatalogV1)(envelope.data).pipe(
            Effect.mapError((cause) => storageError("migrate", cause)),
          );
          current = {
            lineages: legacy.lineages,
            links: legacy.links.map((link) => ({
              lineageId: link.lineageId,
              target: { type: "session", sessionId: link.sessionId },
              selection: { mode: "pinned", revision: link.revision },
              createdAt: link.createdAt,
            })),
          };
          yield* saveUnlocked(current);
        } else if (envelope.version === CATALOG_VERSION) {
          current = yield* Schema.decodeUnknownEffect(ArtifactCatalog)(envelope.data).pipe(
            Effect.mapError((cause) => storageError("load", cause)),
          );
        } else {
          return yield* storageError(
            "load",
            `Unsupported artifact catalog version ${envelope.version}`,
          );
        }
        return yield* Effect.try({
          try: () => validateCatalog(current),
          catch: (cause) => storageError("load", cause),
        });
      });

      const readRevisionUnlocked = Effect.fn("ArtifactStorage.readRevisionUnlocked")(function* (
        catalog: ArtifactCatalog,
        lineageId: ArtifactLineageId,
        requestedRevision?: ArtifactRevisionNumber,
      ) {
        const lineage = catalog.lineages.find((candidate) => candidate.id === lineageId);
        if (!lineage) return undefined;
        const metadata = lineage.revisions.find(
          (candidate) => candidate.revision === (requestedRevision ?? lineage.latestRevision),
        );
        if (!metadata) return undefined;
        const serialized = yield* readText("read", blobPath(metadata.digest));
        if (digest(serialized) !== metadata.digest)
          return yield* storageError(
            "read",
            `Artifact ${lineageId}@r${metadata.revision} blob digest does not match`,
          );
        const decoded = yield* decodeBlob(serialized);
        if (
          decoded.snapshot.id !== lineageId ||
          decoded.snapshot.revision !== metadata.revision ||
          decoded.snapshot.sessionId !== metadata.publishedBySessionId ||
          decoded.storedKind !== metadata.kind
        )
          return yield* storageError(
            "read",
            `Artifact ${lineageId}@r${metadata.revision} metadata does not match its blob`,
          );
        return yield* Schema.decodeUnknownEffect(ArtifactRevision)({
          lineageId,
          metadata,
          snapshot: decoded.snapshot,
        }).pipe(Effect.mapError((cause) => storageError("read", cause)));
      });

      const publish = Effect.fn("ArtifactStorage.publish")(function* (input) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            const lineage = catalog.lineages.find((candidate) => candidate.id === input.lineageId);
            const actualLatestRevision = lineage?.latestRevision ?? 0;
            if (actualLatestRevision !== input.expectedLatestRevision)
              return yield* new ArtifactPublicationConflict({
                lineageId: input.lineageId,
                expectedLatestRevision: input.expectedLatestRevision,
                actualLatestRevision,
              });
            const nextRevision = actualLatestRevision + 1;
            if (
              input.snapshot.kind === "request" ||
              input.snapshot.id !== input.lineageId ||
              input.snapshot.revision !== nextRevision
            )
              return yield* storageError(
                "publish",
                "Artifact snapshot identity/revision must match the lineage next revision and requests are not reusable artifacts",
              );
            if (
              input.restoredFromRevision !== undefined &&
              (input.restoredFromRevision > actualLatestRevision || actualLatestRevision === 0)
            )
              return yield* storageError("publish", "Restore source must be an existing revision");
            const serialized = `${JSON.stringify(input.snapshot, null, 2)}\n`;
            const blobDigest = yield* Schema.decodeUnknownEffect(ArtifactDigest)(
              digest(serialized),
            ).pipe(Effect.mapError((cause) => storageError("publish", cause)));
            const targetBlob = blobPath(blobDigest);
            if (
              yield* fileSystem
                .exists(targetBlob)
                .pipe(Effect.mapError((cause) => storageError("publish", cause)))
            ) {
              const existing = yield* readText("publish", targetBlob);
              if (existing !== serialized || digest(existing) !== blobDigest)
                return yield* storageError(
                  "publish",
                  `Existing content-addressed blob ${blobDigest} is corrupt`,
                );
            } else yield* writeText("publish", targetBlob, serialized);
            const now = DateTime.formatIso(yield* DateTime.now);
            const revision = yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
              nextRevision,
            ).pipe(Effect.mapError((cause) => storageError("publish", cause)));
            const metadata: ArtifactRevisionMetadata = {
              revision,
              digest: blobDigest,
              kind: input.snapshot.kind,
              publishedAt: now,
              publishedBySessionId: input.snapshot.sessionId,
              workingDirectory: input.workingDirectory,
              ...(input.restoredFromRevision === undefined
                ? null
                : { restoredFromRevision: input.restoredFromRevision }),
            };
            const nextLineage: ArtifactLineage = lineage
              ? {
                  ...lineage,
                  latestRevision: revision,
                  revisions: [...lineage.revisions, metadata],
                }
              : {
                  id: input.lineageId,
                  createdAt: now,
                  latestRevision: revision,
                  revisions: [metadata],
                };
            yield* saveUnlocked({
              ...catalog,
              lineages: lineage
                ? catalog.lineages.map((candidate) =>
                    candidate.id === input.lineageId ? nextLineage : candidate,
                  )
                : [...catalog.lineages, nextLineage],
            });
            return yield* Schema.decodeUnknownEffect(ArtifactRevision)({
              lineageId: input.lineageId,
              metadata,
              snapshot: input.snapshot,
            }).pipe(Effect.mapError((cause) => storageError("publish", cause)));
          }),
        );
      });

      const read = Effect.fn("ArtifactStorage.read")((lineageId, revision) =>
        lock.withPermits(1)(
          loadUnlocked().pipe(
            Effect.flatMap((catalog) => readRevisionUnlocked(catalog, lineageId, revision)),
          ),
        ),
      );
      const listRevisions = Effect.fn("ArtifactStorage.listRevisions")((lineageId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            const lineage = catalog.lineages.find((candidate) => candidate.id === lineageId);
            if (!lineage) return [];
            return yield* Effect.forEach(lineage.revisions, (metadata) =>
              readRevisionUnlocked(catalog, lineageId, metadata.revision).pipe(
                Effect.flatMap((revision) =>
                  revision === undefined
                    ? storageError("listRevisions", `Missing revision ${metadata.revision}`)
                    : Effect.succeed(revision),
                ),
              ),
            );
          }),
        ),
      );
      const putLink = Effect.fn("ArtifactStorage.putLink")((input) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const link = yield* Schema.decodeUnknownEffect(ArtifactLink)(input).pipe(
              Effect.mapError((cause) => storageError("putLink", cause)),
            );
            const catalog = yield* loadUnlocked();
            const lineage = catalog.lineages.find((candidate) => candidate.id === link.lineageId);
            if (!lineage) return yield* storageError("putLink", "Artifact lineage does not exist");
            const selection = link.selection;
            if (
              selection.mode === "pinned" &&
              !lineage.revisions.some((item) => item.revision === selection.revision)
            )
              return yield* storageError("putLink", "Pinned artifact revision does not exist");
            const key = linkKey(link);
            yield* saveUnlocked({
              ...catalog,
              links: [...catalog.links.filter((candidate) => linkKey(candidate) !== key), link],
            });
          }),
        ),
      );
      const removeLink = Effect.fn("ArtifactStorage.removeLink")((target, lineageId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            yield* saveUnlocked({
              ...catalog,
              links: catalog.links.filter(
                (link) =>
                  !(link.lineageId === lineageId && targetKey(link.target) === targetKey(target)),
              ),
            });
          }),
        ),
      );
      const resolveLinks = Effect.fn("ArtifactStorage.resolveLinks")((target) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            const links = catalog.links.filter(
              (candidate) => targetKey(candidate.target) === targetKey(target),
            );
            return yield* Effect.forEach(links, (link) => {
              const lineage = catalog.lineages.find((candidate) => candidate.id === link.lineageId);
              const revision =
                link.selection.mode === "pinned"
                  ? link.selection.revision
                  : lineage?.latestRevision;
              if (revision === undefined)
                return storageError("resolveLinks", `Missing lineage ${link.lineageId}`);
              return readRevisionUnlocked(catalog, link.lineageId, revision).pipe(
                Effect.flatMap((value) =>
                  value === undefined
                    ? storageError(
                        "resolveLinks",
                        `Missing revision ${link.lineageId}@r${revision}`,
                      )
                    : Effect.succeed(value),
                ),
              );
            });
          }),
        ),
      );
      const removeTargetLinks = Effect.fn("ArtifactStorage.removeTargetLinks")((target) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            yield* saveUnlocked({
              ...catalog,
              links: catalog.links.filter(
                (candidate) => targetKey(candidate.target) !== targetKey(target),
              ),
            });
          }),
        ),
      );
      const catalog = Effect.fn("ArtifactStorage.catalog")(() =>
        lock.withPermits(1)(loadUnlocked()),
      );
      const deleteBlobIfOrphaned = Effect.fn("ArtifactStorage.deleteBlobIfOrphaned")((value) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* loadUnlocked();
            if (
              current.lineages.some((lineage) =>
                lineage.revisions.some((revision) => revision.digest === value),
              )
            )
              return false;
            const target = blobPath(value);
            if (
              !(yield* fileSystem
                .exists(target)
                .pipe(Effect.mapError((cause) => storageError("deleteBlobIfOrphaned", cause))))
            )
              return false;
            yield* fileSystem
              .remove(target, { force: true })
              .pipe(Effect.mapError((cause) => storageError("deleteBlobIfOrphaned", cause)));
            return true;
          }),
        ),
      );

      return ArtifactStorage.of({
        publish,
        read,
        listRevisions,
        putLink,
        removeLink,
        resolveLinks,
        removeTargetLinks,
        catalog,
        deleteBlobIfOrphaned,
      });
    }),
  );
