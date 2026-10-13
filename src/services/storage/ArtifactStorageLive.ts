import { createHash } from "node:crypto";
import { WidgetBrowserOutput } from "../../contracts/widgets/widget-browser-output";
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
  ArtifactRevisionMetadata,
} from "../../contracts/artifacts/artifact-lineage";
import {
  cakeArtifactV1Schema,
  parseArtifactInput,
  type CakeArtifactV1,
} from "../../contracts/artifacts/artifact-contract";
import {
  ArtifactPublicationConflict,
  ArtifactStorageError,
} from "../../contracts/storage/artifact-storage-errors";
import { ArtifactStorage, type ArtifactCollectionInput } from "./ArtifactStorage";
import { atomicWriteFile } from "./internal/atomicFile";

import {
  ArtifactState,
  ArtifactStateConflict,
  ArtifactStateReplacement,
} from "../../contracts/artifacts/artifact-state";

const CATALOG_VERSION = 4;
// Catalog migration reads identity/title only, never interprets historical payloads.
const StoredArtifactHeader = Schema.Struct({
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

/** Version-one storage included ephemeral blocking requests. They are discarded
 * during migration, never decoded as current reusable artifacts. */
const LegacyRequestHeader = Schema.Struct({
  protocol: Schema.Literal("cake.artifact/v1"),
  kind: Schema.Literal("request"),
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

interface LegacyBlob {
  readonly digest: string;
  readonly decoded: DecodedBlob;
}

interface LegacyIndex {
  readonly value: typeof LegacyMetadata.Type;
  readonly sessionHash: string;
  readonly targetSessionId: string;
}

interface LegacySessionProvenance {
  readonly sessionIds: ReadonlySet<string>;
  readonly parentBySessionId: ReadonlyMap<string, string>;
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
      // Transaction scratch, refreshed from disk under the same repository lock on every load.
      // The envelope is replaced atomically; it contains only the current value, never state history.
      let currentStates: ReadonlyArray<ArtifactState> = [];
      const stateFor = (lineageId: ArtifactLineageId): ArtifactState =>
        currentStates.find((state) => state.lineageId === lineageId) ?? {
          lineageId,
          version: 0,
          value: null,
        };
      const replaceCurrentState = (next: ArtifactState) => {
        currentStates = [
          ...currentStates.filter((state) => state.lineageId !== next.lineageId),
          next,
        ];
      };
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
          `${JSON.stringify({ version: CATALOG_VERSION, data: { ...encoded, states: currentStates.filter((state) => catalog.lineages.some((lineage) => lineage.id === state.lineageId)) } }, null, 2)}\n`,
        );
      });

      const readLegacySessionProvenance = Effect.fn("ArtifactStorage.readLegacySessionProvenance")(
        function* () {
          const familyPath = path.join(path.dirname(root), "session-families.json");
          if (!(yield* fileSystem.exists(familyPath).pipe(Effect.orElseSucceed(() => false))))
            return {
              sessionIds: new Set<string>(),
              parentBySessionId: new Map<string, string>(),
            } satisfies LegacySessionProvenance;
          const schema = Schema.Struct({
            version: Schema.Int,
            data: Schema.Struct({
              families: Schema.Array(
                Schema.Struct({
                  familyId: Schema.String,
                  parentSessionId: Schema.String,
                  children: Schema.Array(
                    Schema.Struct({
                      sessionId: Schema.String,
                      parentSessionId: Schema.optionalKey(Schema.String),
                    }),
                  ),
                }),
              ),
            }),
          });
          const decoded = yield* readText("migrate", familyPath).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
            Effect.mapError((cause) => storageError("migrate", cause)),
          );
          const sessionIds = new Set<string>();
          const parentBySessionId = new Map<string, string>();
          for (const family of decoded.data.families) {
            sessionIds.add(family.parentSessionId);
            for (const child of family.children) {
              const parentSessionId = child.parentSessionId ?? family.parentSessionId;
              sessionIds.add(child.sessionId);
              sessionIds.add(parentSessionId);
              const existing = parentBySessionId.get(child.sessionId);
              if (existing !== undefined && existing !== parentSessionId)
                return yield* storageError(
                  "migrate",
                  `Legacy session ${child.sessionId} has ambiguous parent provenance`,
                );
              parentBySessionId.set(child.sessionId, parentSessionId);
            }
          }
          for (const sessionId of sessionIds) {
            const visited = new Set<string>();
            let current: string | undefined = sessionId;
            while (current !== undefined) {
              if (visited.has(current))
                return yield* storageError(
                  "migrate",
                  `Legacy session provenance contains a cycle at ${current}`,
                );
              visited.add(current);
              current = parentBySessionId.get(current);
            }
          }
          return { sessionIds, parentBySessionId } satisfies LegacySessionProvenance;
        },
      );

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

          const blobsByDigest = new Map<string, LegacyBlob>();
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
                if (
                  Schema.decodeUnknownOption(Schema.fromJsonString(LegacyRequestHeader))(serialized)
                    ._tag === "Some"
                )
                  return;
                const decoded = yield* decodeBlob(serialized);
                blobsByDigest.set(expected, { digest: expected, decoded });
              }),
              { discard: true },
            );
          }

          const provenance = yield* readLegacySessionProvenance();
          const unresolvedIndexes: Array<{
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
                        if (digest(value.workspacePath) !== workspaceHash)
                          return yield* storageError(
                            "migrate",
                            `Index for ${value.id} is stored under the wrong workspace`,
                          );
                        if (`${digest(value.id)}.json` !== name)
                          return yield* storageError(
                            "migrate",
                            `Index for ${value.id} is stored under the wrong artifact key`,
                          );
                        if (value.kind === "request") return;
                        const blob = blobsByDigest.get(value.digest);
                        if (!blob)
                          return yield* storageError(
                            "migrate",
                            `Index for ${value.id} references missing blob ${value.digest}`,
                          );
                        if (
                          blob.decoded.snapshot.id !== value.id ||
                          blob.decoded.snapshot.sessionId !== value.sessionId ||
                          blob.decoded.snapshot.revision !== value.revision ||
                          blob.decoded.storedKind !== value.kind
                        )
                          return yield* storageError(
                            "migrate",
                            `Index metadata for ${value.id} does not match its blob`,
                          );
                        unresolvedIndexes.push({ value, sessionHash });
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

          const candidateSessionIds = new Set<string>(provenance.sessionIds);
          for (const { value } of unresolvedIndexes) {
            candidateSessionIds.add(value.sessionId);
            if (value.targetSessionId !== undefined) candidateSessionIds.add(value.targetSessionId);
          }
          const indexes: LegacyIndex[] = [];
          for (const item of unresolvedIndexes) {
            const matchingTargets = [...candidateSessionIds].filter(
              (candidate) => digest(candidate) === item.sessionHash,
            );
            const targetSessionId = item.value.targetSessionId ?? matchingTargets[0];
            if (
              targetSessionId === undefined ||
              digest(targetSessionId) !== item.sessionHash ||
              matchingTargets.length > 1
            )
              return yield* storageError(
                "migrate",
                `Cannot unambiguously identify legacy session link for artifact ${item.value.id}`,
              );
            indexes.push({ ...item, targetSessionId });
          }
          indexes.sort((left, right) =>
            `${left.targetSessionId}\u0000${left.value.id}\u0000${left.value.digest}`.localeCompare(
              `${right.targetSessionId}\u0000${right.value.id}\u0000${right.value.digest}`,
            ),
          );

          const parentBySessionId = new Map(provenance.parentBySessionId);
          const inheritedPublishers = new Map<string, Set<string>>();
          for (const index of indexes) {
            if (index.targetSessionId === index.value.sessionId) continue;
            const key = sourceKey(index.targetSessionId, index.value.id);
            const publishers = inheritedPublishers.get(key) ?? new Set<string>();
            publishers.add(index.value.sessionId);
            inheritedPublishers.set(key, publishers);
          }

          const indexedArtifactIds = new Set(indexes.map((index) => index.value.id));
          const blobsByArtifactRevision = new Map<string, Map<number, LegacyBlob[]>>();
          for (const blob of blobsByDigest.values()) {
            const snapshot = blob.decoded.snapshot;
            if (!indexedArtifactIds.has(snapshot.id)) continue;
            const byRevision = blobsByArtifactRevision.get(snapshot.id) ?? new Map();
            const candidates = byRevision.get(snapshot.revision) ?? [];
            candidates.push(blob);
            byRevision.set(snapshot.revision, candidates);
            blobsByArtifactRevision.set(snapshot.id, byRevision);
          }

          const choosePredecessor = (
            current: LegacyBlob,
            candidates: ReadonlyArray<LegacyBlob>,
          ): LegacyBlob | undefined => {
            const publisher = current.decoded.snapshot.sessionId;
            const samePublisher = candidates.filter(
              (candidate) => candidate.decoded.snapshot.sessionId === publisher,
            );
            if (samePublisher.length === 1) return samePublisher[0];
            if (samePublisher.length > 1)
              throw new Error(
                `Artifact ${current.decoded.snapshot.id}@r${current.decoded.snapshot.revision} has ambiguous same-session history`,
              );

            const distanceByAncestor = new Map<string, number>();
            const visitAncestors = (start: string | undefined, startingDistance: number) => {
              const visited = new Set<string>([publisher]);
              let ancestor: string | undefined = start;
              let distance = startingDistance;
              while (ancestor !== undefined) {
                if (visited.has(ancestor))
                  throw new Error(`Legacy session provenance contains a cycle at ${ancestor}`);
                visited.add(ancestor);
                const existingDistance = distanceByAncestor.get(ancestor);
                if (existingDistance === undefined || distance < existingDistance)
                  distanceByAncestor.set(ancestor, distance);
                distance += 1;
                ancestor = parentBySessionId.get(ancestor);
              }
            };
            visitAncestors(parentBySessionId.get(publisher), 1);
            for (const inheritedPublisher of inheritedPublishers.get(
              sourceKey(publisher, current.decoded.snapshot.id),
            ) ?? [])
              visitAncestors(inheritedPublisher, 1);
            const related = candidates
              .map((candidate) => ({
                candidate,
                distance: distanceByAncestor.get(candidate.decoded.snapshot.sessionId),
              }))
              .filter(
                (item): item is { candidate: LegacyBlob; distance: number } =>
                  item.distance !== undefined,
              );
            if (related.length > 0) {
              const nearest = Math.min(...related.map((item) => item.distance));
              const nearestCandidates = related.filter((item) => item.distance === nearest);
              if (nearestCandidates.length === 1) return nearestCandidates[0]?.candidate;
              throw new Error(
                `Artifact ${current.decoded.snapshot.id}@r${current.decoded.snapshot.revision} has ambiguous ancestor history`,
              );
            }
            if (candidates.length === 1) return candidates[0];
            if (candidates.length > 1)
              throw new Error(
                `Artifact ${current.decoded.snapshot.id}@r${current.decoded.snapshot.revision} has ambiguous legacy predecessor`,
              );
            return undefined;
          };

          const chainByIndex = new Map<LegacyIndex, ReadonlyArray<LegacyBlob>>();
          for (const index of indexes) {
            const tip = blobsByDigest.get(index.value.digest);
            if (!tip) continue;
            const reversed = [tip];
            let current = tip;
            while (current.decoded.snapshot.revision > 1) {
              const candidates =
                blobsByArtifactRevision
                  .get(current.decoded.snapshot.id)
                  ?.get(current.decoded.snapshot.revision - 1) ?? [];
              const predecessor = yield* Effect.try({
                try: () => choosePredecessor(current, candidates),
                catch: (cause) => storageError("migrate", cause),
              });
              if (!predecessor)
                return yield* storageError(
                  "migrate",
                  `Artifact ${current.decoded.snapshot.id} has a non-contiguous legacy revision history before r${current.decoded.snapshot.revision}`,
                );
              reversed.push(predecessor);
              current = predecessor;
            }
            chainByIndex.set(index, reversed.reverse());
          }

          const chainKey = (chain: ReadonlyArray<LegacyBlob>) =>
            chain.map((blob) => blob.digest).join("\u0000");
          const uniqueChains = new Map<string, ReadonlyArray<LegacyBlob>>();
          for (const chain of chainByIndex.values()) uniqueChains.set(chainKey(chain), chain);
          const isPrefix = (prefix: ReadonlyArray<LegacyBlob>, value: ReadonlyArray<LegacyBlob>) =>
            prefix.length <= value.length &&
            prefix.every((blob, index) => blob.digest === value[index]?.digest);
          const maximalChains = [...uniqueChains.values()].filter(
            (candidate) =>
              ![...uniqueChains.values()].some(
                (other) => other.length > candidate.length && isPrefix(candidate, other),
              ),
          );
          const maximalChainByIndex = new Map<LegacyIndex, ReadonlyArray<LegacyBlob>>();
          for (const [index, chain] of chainByIndex) {
            const continuations = maximalChains.filter((candidate) => isPrefix(chain, candidate));
            if (continuations.length !== 1)
              return yield* storageError(
                "migrate",
                `Legacy link for ${index.value.id}@r${index.value.revision} has ambiguous divergent history`,
              );
            const continuation = continuations[0];
            if (!continuation)
              return yield* storageError(
                "migrate",
                `Legacy link for ${index.value.id} has no revision history`,
              );
            maximalChainByIndex.set(index, continuation);
          }

          const chainsByArtifactId = new Map<string, ReadonlyArray<ReadonlyArray<LegacyBlob>>>();
          for (const chain of maximalChains) {
            const artifactId = chain[0]?.decoded.snapshot.id;
            if (!artifactId) continue;
            chainsByArtifactId.set(artifactId, [
              ...(chainsByArtifactId.get(artifactId) ?? []),
              chain,
            ]);
          }
          const usedLineageIds = new Set<string>(indexedArtifactIds);
          const allocateCollisionId = (baseId: string, identity: string) => {
            const identityDigest = digest(identity);
            for (let length = 12; length <= identityDigest.length; length += 4) {
              const suffix = `-${identityDigest.slice(0, length)}`;
              const candidate = `${baseId.slice(0, 256 - suffix.length)}${suffix}`;
              if (!usedLineageIds.has(candidate)) return candidate;
            }
            throw new Error(`Cannot allocate a collision-safe lineage ID for ${baseId}`);
          };

          const normalizedWrites = new Map<string, string>();
          const lineageIdByChain = new Map<string, ArtifactLineageId>();
          const lineages: ArtifactLineage[] = [];
          for (const artifactId of [...chainsByArtifactId.keys()].sort()) {
            const chains = [...(chainsByArtifactId.get(artifactId) ?? [])].sort((left, right) =>
              chainKey(left).localeCompare(chainKey(right)),
            );
            for (const [chainIndex, chain] of chains.entries()) {
              const chosenId =
                chainIndex === 0 ? artifactId : allocateCollisionId(artifactId, chainKey(chain));
              const lineageId = yield* Schema.decodeUnknownEffect(ArtifactLineageId)(chosenId).pipe(
                Effect.mapError((cause) => storageError("migrate", cause)),
              );
              usedLineageIds.add(lineageId);
              lineageIdByChain.set(chainKey(chain), lineageId);
              const associatedIndexes = indexes.filter(
                (index) => maximalChainByIndex.get(index) === chain,
              );
              const fallbackIndex = associatedIndexes[0];
              if (!fallbackIndex)
                return yield* storageError("migrate", `Artifact ${artifactId} has no legacy index`);
              const revisions: ArtifactRevisionMetadata[] = [];
              for (const blob of chain) {
                const snapshot = blob.decoded.snapshot;
                const exactIndexes = indexes.filter((index) => index.value.digest === blob.digest);
                const ownerIndexes = exactIndexes.filter(
                  (index) => index.targetSessionId === snapshot.sessionId,
                );
                const preferredIndexes = ownerIndexes.length > 0 ? ownerIndexes : exactIndexes;
                const workingDirectories = new Set(
                  preferredIndexes.map((index) => index.value.workspacePath),
                );
                if (workingDirectories.size > 1)
                  return yield* storageError(
                    "migrate",
                    `Artifact ${artifactId}@r${snapshot.revision} has ambiguous workspace provenance`,
                  );
                const metadataIndex = preferredIndexes[0] ?? fallbackIndex;
                let revisionDigest = blob.digest;
                let storedKind = blob.decoded.storedKind;
                if (lineageId !== artifactId) {
                  const normalizedSnapshot = { ...snapshot, id: lineageId };
                  const serialized = `${JSON.stringify(normalizedSnapshot, null, 2)}\n`;
                  revisionDigest = digest(serialized);
                  storedKind = normalizedSnapshot.kind;
                  normalizedWrites.set(revisionDigest, serialized);
                }
                revisions.push({
                  revision: yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
                    snapshot.revision,
                  ).pipe(Effect.mapError((cause) => storageError("migrate", cause))),
                  digest: yield* Schema.decodeUnknownEffect(ArtifactDigest)(revisionDigest).pipe(
                    Effect.mapError((cause) => storageError("migrate", cause)),
                  ),
                  kind: storedKind,
                  ...(snapshot.title === undefined ? null : { title: snapshot.title }),
                  publishedAt:
                    snapshot.revision === 1
                      ? metadataIndex.value.createdAt
                      : metadataIndex.value.updatedAt,
                  publishedBySessionId: snapshot.sessionId,
                  workingDirectory: metadataIndex.value.workspacePath,
                });
              }
              const firstRevision = revisions[0];
              const latestRevision = revisions.at(-1);
              if (!firstRevision || !latestRevision)
                return yield* storageError("migrate", `Artifact ${artifactId} has no revisions`);
              lineages.push({
                id: lineageId,
                createdAt: firstRevision.publishedAt,
                latestRevision: latestRevision.revision,
                revisions,
              });
            }
          }

          const linksByKey = new Map<string, ArtifactLink>();
          for (const index of indexes) {
            const chain = maximalChainByIndex.get(index);
            if (!chain) continue;
            const lineageId = lineageIdByChain.get(chainKey(chain));
            if (!lineageId)
              return yield* storageError(
                "migrate",
                `Cannot identify migrated lineage for artifact ${index.value.id}`,
              );
            const link: ArtifactLink = {
              lineageId,
              target: { type: "session", sessionId: index.targetSessionId },
              selection:
                index.targetSessionId === index.value.sessionId
                  ? { mode: "follow-latest" }
                  : {
                      mode: "pinned",
                      revision: yield* Schema.decodeUnknownEffect(ArtifactRevisionNumber)(
                        index.value.revision,
                      ).pipe(Effect.mapError((cause) => storageError("migrate", cause))),
                    },
              createdAt: index.value.createdAt,
            };
            const key = linkKey(link);
            const existing = linksByKey.get(key);
            if (existing && JSON.stringify(existing.selection) !== JSON.stringify(link.selection))
              return yield* storageError(
                "migrate",
                `Legacy links for ${index.value.id} have conflicting revision selections`,
              );
            linksByKey.set(key, link);
          }
          const migrated = yield* Effect.try({
            try: () => validateCatalog({ lineages, links: [...linksByKey.values()] }),
            catch: (cause) => storageError("migrate", cause),
          });
          for (const [blobDigest, serialized] of normalizedWrites) {
            const target = blobPath(blobDigest);
            if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) {
              const existing = yield* readText("migrate", target);
              if (existing !== serialized || digest(existing) !== blobDigest)
                return yield* storageError(
                  "migrate",
                  `Existing normalized blob ${blobDigest} is corrupt`,
                );
            } else yield* writeText("migrate", target, serialized);
          }
          return migrated;
        },
      );

      const loadUnlocked = Effect.fn("ArtifactStorage.loadUnlocked")(function* () {
        const exists = yield* fileSystem
          .exists(catalogPath)
          .pipe(Effect.mapError((cause) => storageError("load", cause)));
        if (!exists) {
          currentStates = [];
          const migrated = yield* migrateLegacyUnlocked();
          yield* saveUnlocked(migrated);
          return migrated;
        }
        const envelope = yield* readText("load", catalogPath).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(CatalogEnvelope))),
          Effect.mapError((cause) => storageError("load", cause)),
        );
        let current: ArtifactCatalog;
        currentStates = [];
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
        } else if (envelope.version === 2) {
          current = yield* Schema.decodeUnknownEffect(ArtifactCatalog)(envelope.data).pipe(
            Effect.mapError((cause) => storageError("load", cause)),
          );
        } else if (envelope.version === 3 || envelope.version === CATALOG_VERSION) {
          const decoded = yield* Schema.decodeUnknownEffect(CurrentCatalogData)(envelope.data).pipe(
            Effect.mapError((cause) => storageError("load", cause)),
          );
          current = { lineages: decoded.lineages, links: decoded.links };
          currentStates = decoded.states;
          if (
            new Set(currentStates.map((state) => state.lineageId)).size !== currentStates.length ||
            currentStates.some(
              (state) => !current.lineages.some((lineage) => lineage.id === state.lineageId),
            )
          )
            return yield* storageError("load", "Invalid artifact current-state collection");
        } else {
          return yield* storageError(
            "load",
            `Unsupported artifact catalog version ${envelope.version}`,
          );
        }
        if (envelope.version < CATALOG_VERSION) {
          // Backfill catalog titles without rewriting immutable source or requiring
          // unrelated historical widgets to satisfy today's browser-output contract.
          current = {
            ...current,
            lineages: yield* Effect.forEach(current.lineages, (lineage) =>
              Effect.gen(function* () {
                const revisions = yield* Effect.forEach(lineage.revisions, (metadata) =>
                  Effect.gen(function* () {
                    const serialized = yield* readText("migrateTitles", blobPath(metadata.digest));
                    if (digest(serialized) !== metadata.digest)
                      return yield* storageError(
                        "migrateTitles",
                        "Artifact blob digest does not match",
                      );
                    const header = yield* Schema.decodeUnknownEffect(
                      Schema.fromJsonString(StoredArtifactHeader),
                    )(serialized).pipe(
                      Effect.mapError((cause) => storageError("migrateTitles", cause)),
                    );
                    if (header.id !== lineage.id || header.revision !== metadata.revision)
                      return yield* storageError(
                        "migrateTitles",
                        "Artifact header does not match catalog",
                      );
                    return {
                      ...metadata,
                      ...(header.title === undefined ? null : { title: header.title }),
                    };
                  }),
                );
                return { ...lineage, revisions };
              }),
            ),
          };
          yield* saveUnlocked(current);
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

      const publishUnlocked = Effect.fn("ArtifactStorage.publishUnlocked")(function* (
        input: Parameters<ArtifactStorage["Service"]["publish"]>[0],
        initialLink?: ArtifactLink,
      ) {
        const catalog = yield* loadUnlocked();
        const lineage = catalog.lineages.find((candidate) => candidate.id === input.lineageId);
        const actualLatestRevision = lineage?.latestRevision ?? 0;
        if (actualLatestRevision !== input.expectedLatestRevision)
          return yield* new ArtifactPublicationConflict({
            lineageId: input.lineageId,
            expectedLatestRevision: input.expectedLatestRevision,
            actualLatestRevision,
          });
        const stagedState =
          input.stagedState === undefined
            ? undefined
            : yield* Schema.decodeUnknownEffect(ArtifactStateReplacement)({
                lineageId: input.lineageId,
                ...input.stagedState,
              }).pipe(Effect.mapError((cause) => storageError("publishState", cause)));
        const previousState = stateFor(input.lineageId);
        if (stagedState && previousState.version !== stagedState.expectedVersion)
          return yield* new ArtifactStateConflict({
            lineageId: input.lineageId,
            expectedVersion: stagedState.expectedVersion,
            actualVersion: previousState.version,
          });
        if (stagedState && input.snapshot.kind !== "widget")
          return yield* storageError("publishState", "Only widgets own mutable state");
        const nextRevision = actualLatestRevision + 1;
        if (input.snapshot.id !== input.lineageId || input.snapshot.revision !== nextRevision)
          return yield* storageError(
            "publish",
            "Artifact snapshot identity/revision must match the lineage next revision",
          );
        if (
          input.restoredFromRevision !== undefined &&
          (input.restoredFromRevision > actualLatestRevision || actualLatestRevision === 0)
        )
          return yield* storageError("publish", "Restore source must be an existing revision");
        if (
          initialLink &&
          (actualLatestRevision !== 0 ||
            initialLink.lineageId !== input.lineageId ||
            (initialLink.selection.mode === "pinned" && initialLink.selection.revision !== 1))
        )
          return yield* storageError("publishWithLink", "Initial link must select revision one");
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
          ...(input.snapshot.title === undefined ? null : { title: input.snapshot.title }),
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
        if (stagedState)
          replaceCurrentState({
            lineageId: input.lineageId,
            version: previousState.version + 1,
            value: stagedState.value,
          });
        yield* saveUnlocked({
          lineages: lineage
            ? catalog.lineages.map((candidate) =>
                candidate.id === input.lineageId ? nextLineage : candidate,
              )
            : [...catalog.lineages, nextLineage],
          links: initialLink ? [...catalog.links, initialLink] : catalog.links,
        });
        return yield* Schema.decodeUnknownEffect(ArtifactRevision)({
          lineageId: input.lineageId,
          metadata,
          snapshot: input.snapshot,
        }).pipe(Effect.mapError((cause) => storageError("publish", cause)));
      });

      const publish = Effect.fn("ArtifactStorage.publish")((input) =>
        lock.withPermits(1)(publishUnlocked(input)),
      );
      const publishWithLink = Effect.fn("ArtifactStorage.publishWithLink")((input, link) =>
        lock.withPermits(1)(
          Schema.decodeUnknownEffect(ArtifactLink)(link).pipe(
            Effect.mapError((cause) => storageError("publishWithLink", cause)),
            Effect.flatMap((decoded) => publishUnlocked(input, decoded)),
          ),
        ),
      );

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
      const catalogToken = (value: ArtifactCatalog) => digest(JSON.stringify(value));
      const catalog = Effect.fn("ArtifactStorage.catalog")(() =>
        lock.withPermits(1)(loadUnlocked()),
      );
      const collectionSnapshot = Effect.fn("ArtifactStorage.collectionSnapshot")(() =>
        lock.withPermits(1)(
          loadUnlocked().pipe(Effect.map((catalog) => ({ catalog, token: catalogToken(catalog) }))),
        ),
      );
      const browserReference = Schema.Struct({
        kind: Schema.Literal("widget"),
        payload: Schema.Struct({ browser: WidgetBrowserOutput }),
      });
      const browserDigestFromBlob = Effect.fn("ArtifactStorage.browserDigestFromBlob")(function* (
        target: string,
      ) {
        const serialized = yield* readText("browserOutputGC", target);
        const browser = Schema.decodeUnknownOption(Schema.fromJsonString(browserReference))(
          serialized,
        );
        return browser._tag === "Some" ? browser.value.payload.browser.digest : undefined;
      });
      const retainedBrowserDigests = Effect.fn("ArtifactStorage.retainedBrowserDigests")(function* (
        catalog: ArtifactCatalog,
      ) {
        const retained = new Set<string>();
        for (const lineage of catalog.lineages)
          for (const revision of lineage.revisions) {
            const browser = yield* browserDigestFromBlob(blobPath(revision.digest));
            if (browser) retained.add(browser);
          }
        return retained;
      });
      const removeBrowserOutput = Effect.fn("ArtifactStorage.removeBrowserOutput")(function* (
        browser: string | undefined,
        retained: ReadonlySet<string>,
      ) {
        if (browser && !retained.has(browser))
          yield* fileSystem
            .remove(path.join(root, "browser-outputs", browser), { recursive: true, force: true })
            .pipe(Effect.mapError((cause) => storageError("browserOutputGC", cause)));
      });
      const collectUnreachable = Effect.fn("ArtifactStorage.collectUnreachable")(function* (
        input: ArtifactCollectionInput,
      ) {
        return yield* lock.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* loadUnlocked();
            if (catalogToken(current) !== input.expectedCatalogToken)
              return {
                skipped: true,
                lineagesRemoved: 0,
                revisionsRemoved: 0,
                linksRemoved: 0,
                blobsRemoved: 0,
              };

            const sessions = new Set(input.survivingSessionIds);
            const families = new Set(input.survivingFamilyIds);
            const transcriptLineages = new Set(input.transcriptLineageIds);
            const retainedLinks = current.links.filter((link) =>
              link.target.type === "session"
                ? sessions.has(link.target.sessionId)
                : families.has(link.target.familyId),
            );
            const retainedLineageIds = new Set<string>([
              ...transcriptLineages,
              ...retainedLinks.map((link) => link.lineageId),
            ]);
            const retainedLineages = current.lineages.filter((lineage) =>
              retainedLineageIds.has(lineage.id),
            );
            const removedLineages = current.lineages.filter(
              (lineage) => !retainedLineageIds.has(lineage.id),
            );
            const retainedIdSet = new Set(retainedLineages.map((lineage) => lineage.id));
            const nextLinks = retainedLinks.filter((link) => retainedIdSet.has(link.lineageId));
            const linksRemoved = current.links.length - nextLinks.length;
            if (removedLineages.length > 0 || linksRemoved > 0)
              yield* saveUnlocked({ lineages: retainedLineages, links: nextLinks });

            const retainedDigests = new Set<string>(
              retainedLineages.flatMap((lineage) =>
                lineage.revisions.map((revision) => revision.digest),
              ),
            );
            const hasBlobDirectory = yield* fileSystem
              .exists(blobDirectory)
              .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)));
            const blobNames = hasBlobDirectory
              ? yield* fileSystem
                  .readDirectory(blobDirectory)
                  .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)))
              : [];
            // Board entries and receipts share artifact reachability, but are not revision blobs.
            const boardDirectory = path.join(root, "boards");
            const retainedBoards = new Set(retainedLineages.map((lineage) => digest(lineage.id)));
            if (
              yield* fileSystem
                .exists(boardDirectory)
                .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)))
            ) {
              const boards = yield* fileSystem
                .readDirectory(boardDirectory)
                .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)));
              for (const name of boards) {
                if (!/^[a-f0-9]{64}$/.test(name) || retainedBoards.has(name)) continue;
                yield* fileSystem
                  .remove(path.join(boardDirectory, name), { recursive: true, force: true })
                  .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)));
              }
            }
            // Resolve every surviving browser reference before deleting any output. The
            // repository lock also protects this decision from concurrent publication.
            const retainedBrowsers = yield* retainedBrowserDigests({
              lineages: retainedLineages,
              links: nextLinks,
            });
            let blobsRemoved = 0;
            for (const name of blobNames) {
              const match = /^([a-f0-9]{64})\.json$/.exec(name);
              if (!match || retainedDigests.has(match[1]!)) continue;
              const browser = yield* browserDigestFromBlob(path.join(blobDirectory, name));
              yield* removeBrowserOutput(browser, retainedBrowsers);
              yield* fileSystem
                .remove(path.join(blobDirectory, name), { force: true })
                .pipe(Effect.mapError((cause) => storageError("collectUnreachable", cause)));
              blobsRemoved += 1;
            }
            return {
              skipped: false,
              lineagesRemoved: removedLineages.length,
              revisionsRemoved: removedLineages.reduce(
                (count, lineage) => count + lineage.revisions.length,
                0,
              ),
              linksRemoved,
              blobsRemoved,
            };
          }),
        );
      });
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
            const browser = yield* browserDigestFromBlob(target);
            if (browser)
              yield* removeBrowserOutput(browser, yield* retainedBrowserDigests(current));
            yield* fileSystem
              .remove(target, { force: true })
              .pipe(Effect.mapError((cause) => storageError("deleteBlobIfOrphaned", cause)));
            return true;
          }),
        ),
      );

      const readState = Effect.fn("ArtifactStorage.readState")((lineageId: ArtifactLineageId) =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            const catalog = yield* loadUnlocked();
            const lineage = catalog.lineages.find((item) => item.id === lineageId);
            if (!lineage || lineage.revisions.at(-1)?.kind !== "widget")
              return yield* storageError(
                "readState",
                "Mutable state requires an existing widget artifact",
              );
            return stateFor(lineageId);
          }),
        ),
      );
      const replaceState = Effect.fn("ArtifactStorage.replaceState")(
        (input: ArtifactStateReplacement) =>
          lock.withPermits(1)(
            Effect.gen(function* () {
              const decoded = yield* Schema.decodeUnknownEffect(ArtifactStateReplacement)(
                input,
              ).pipe(Effect.mapError((cause) => storageError("replaceState", cause)));
              const catalog = yield* loadUnlocked();
              const lineage = catalog.lineages.find((item) => item.id === decoded.lineageId);
              if (!lineage || lineage.revisions.at(-1)?.kind !== "widget")
                return yield* storageError(
                  "replaceState",
                  "Mutable state requires an existing widget artifact",
                );
              const previous = stateFor(decoded.lineageId);
              if (previous.version !== decoded.expectedVersion)
                return yield* new ArtifactStateConflict({
                  lineageId: decoded.lineageId,
                  expectedVersion: decoded.expectedVersion,
                  actualVersion: previous.version,
                });
              const next: ArtifactState = {
                lineageId: decoded.lineageId,
                version: previous.version + 1,
                value: decoded.value,
              };
              replaceCurrentState(next);
              yield* saveUnlocked(catalog);
              return next;
            }),
          ),
      );

      return ArtifactStorage.of({
        readState,
        replaceState,
        publish,
        publishWithLink,
        read,
        listRevisions,
        putLink,
        removeLink,
        resolveLinks,
        removeTargetLinks,
        catalog,
        collectionSnapshot,
        collectUnreachable,
        deleteBlobIfOrphaned,
      });
    }),
  );
