import { Effect, type FileSystem, type Path, Schema } from "effect";
import {
  type ArtifactCatalog,
  ArtifactDigest,
  ArtifactLineageId,
  ArtifactRevisionNumber,
  type ArtifactLink,
  type ArtifactLineage,
  type ArtifactRevisionMetadata,
} from "../../contracts/artifacts/artifact-lineage";
import type { ArtifactStorageError } from "../../contracts/storage/artifact-storage-errors";
import {
  decodeBlob,
  digest,
  linkKey,
  storageError,
  validateCatalog,
  type DecodedBlob,
} from "./artifactStorageCodec";

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

const sourceKey = (sessionId: string, artifactId: string) => `${sessionId}\u0000${artifactId}`;

/** Runs under ArtifactStorage's catalog lock; normalized blobs precede catalog publication. */
export const makeLegacyArtifactMigration = ({
  root,
  fileSystem,
  path,
  readText,
  writeText,
}: {
  readonly root: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly readText: (
    operation: string,
    target: string,
  ) => Effect.Effect<string, ArtifactStorageError>;
  readonly writeText: (
    operation: string,
    target: string,
    content: string,
  ) => Effect.Effect<void, ArtifactStorageError>;
}) => {
  const blobDirectory = path.join(root, "blobs");
  const blobPath = (value: string) => path.join(blobDirectory, `${value}.json`);
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

  const migrateLegacyUnlocked = Effect.fn("ArtifactStorage.migrateLegacyUnlocked")(function* () {
    const sessionsDirectory = path.join(root, "sessions");
    const hasSessions = yield* fileSystem
      .exists(sessionsDirectory)
      .pipe(Effect.mapError((cause) => storageError("migrate", cause)));
    const hasBlobs = yield* fileSystem
      .exists(blobDirectory)
      .pipe(Effect.mapError((cause) => storageError("migrate", cause)));
    if (!hasSessions && !hasBlobs) return { lineages: [], links: [] } satisfies ArtifactCatalog;

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
      chainsByArtifactId.set(artifactId, [...(chainsByArtifactId.get(artifactId) ?? []), chain]);
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
          global: false,
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
  });

  return migrateLegacyUnlocked;
};
