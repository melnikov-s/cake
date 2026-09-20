import { Effect, Schema } from "effect";
import { ArtifactProjection } from "../../services/artifacts/ArtifactProjection";
import { CakeSessionRuntimes } from "../../services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../services/project-sessions/ProjectSessionConfiguration";
import { ArtifactStorage } from "../../services/storage/ArtifactStorage";
import { SessionFamilyStorage, familyMemberIds } from "../../services/storage/SessionFamilyStorage";
import { ArtifactLineageId } from "./artifact-lineage";

interface ArtifactGarbageCollectionStats {
  readonly skipped: boolean;
  readonly lineagesRemoved: number;
  readonly revisionsRemoved: number;
  readonly linksRemoved: number;
  readonly blobsRemoved: number;
  readonly projectionSessionsRemoved: number;
  readonly projectionLineagesRemoved: number;
}

/**
 * Conservatively reconciles the artifact repository against Cake family state and
 * Pi's authoritative durable transcripts. Any incomplete Pi enumeration fails the
 * operation before storage metadata is changed.
 */
export const collectGarbage = Effect.fn("Artifacts.collectGarbage")(function* () {
  const storage = yield* ArtifactStorage;
  const projection = yield* ArtifactProjection;
  const sessions = yield* CakeSessionRuntimes;
  const families = yield* SessionFamilyStorage;
  const configuration = yield* ProjectSessionConfiguration;

  // Snapshot first. Any concurrent publish or link changes the token and makes the
  // eventual storage mutation a conservative no-op.
  const snapshot = yield* storage.collectionSnapshot();
  const [references, familyRecords] = yield* Effect.all([
    sessions.durableArtifactReferences([
      configuration.sessionDirectory,
      configuration.resolvedSessionDirectory,
    ]),
    families.list(),
  ]);
  const transcriptLineageIds = yield* Effect.forEach(references.lineageIds, (lineageId) =>
    Schema.decodeUnknownEffect(ArtifactLineageId)(lineageId),
  );
  const survivingSessions = new Set(references.sessionIds);
  const collected = yield* storage.collectUnreachable({
    expectedCatalogToken: snapshot.token,
    survivingSessionIds: references.sessionIds,
    survivingFamilyIds: familyRecords
      .filter((family) =>
        familyMemberIds(family).some((sessionId) => survivingSessions.has(sessionId)),
      )
      .map((family) => family.familyId),
    transcriptLineageIds,
  });
  if (collected.skipped)
    return {
      ...collected,
      projectionSessionsRemoved: 0,
      projectionLineagesRemoved: 0,
    } satisfies ArtifactGarbageCollectionStats;

  const retained = yield* storage.catalog();
  const retainedBySession = new Map<string, Set<ArtifactLineageId>>();
  const retainProjection = (sessionId: string, lineageId: ArtifactLineageId) => {
    const lineages = retainedBySession.get(sessionId) ?? new Set<ArtifactLineageId>();
    lineages.add(lineageId);
    retainedBySession.set(sessionId, lineages);
  };
  for (const link of retained.links) {
    if (link.target.type === "session") {
      if (survivingSessions.has(link.target.sessionId))
        retainProjection(link.target.sessionId, link.lineageId);
      continue;
    }
    const familyId = link.target.familyId;
    const family = familyRecords.find((candidate) => candidate.familyId === familyId);
    if (!family) continue;
    for (const sessionId of familyMemberIds(family))
      if (survivingSessions.has(sessionId)) retainProjection(sessionId, link.lineageId);
  }
  const projectionStats = yield* projection
    .cleanup({
      retained: [...retainedBySession].map(([sessionId, lineageIds]) => ({
        sessionId,
        lineageIds: [...lineageIds],
      })),
    })
    .pipe(
      Effect.tapError((error) => Effect.logWarning("Artifact projection cleanup failed", error)),
      Effect.orElseSucceed(() => ({ sessionsRemoved: 0, lineagesRemoved: 0 })),
    );
  return {
    ...collected,
    projectionSessionsRemoved: projectionStats.sessionsRemoved,
    projectionLineagesRemoved: projectionStats.lineagesRemoved,
  } satisfies ArtifactGarbageCollectionStats;
});
