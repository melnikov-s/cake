import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect } from "vitest";
import { collectGarbage } from "../../../src/domain/artifacts/artifactGarbageCollection";
import { ArtifactLineageId } from "../../../src/domain/artifacts/artifact-lineage";
import type { CakeArtifactV1 } from "../../../src/ipc/artifact-contract";
import { makeArtifactProjectionLive } from "../../../src/services/artifacts/ArtifactProjectionLive";
import { PiSessionError, PiSessions } from "../../../src/services/pi/PiSessions";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ArtifactStorage } from "../../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../../src/services/storage/ArtifactStorageLive";
import { SessionFamilyStorage } from "../../../src/services/storage/SessionFamilyStorage";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const id = (value: string) => Schema.decodeUnknownSync(ArtifactLineageId)(value);
const snapshot = (lineageId: string, sessionId: string, number = 1): CakeArtifactV1 => ({
  protocol: "cake.artifact/v1",
  id: lineageId,
  sessionId,
  revision: number,
  kind: "markdown",
  payload: { markdown: `${lineageId}-${number}` },
  fallback: { markdown: `${lineageId}-${number}` },
  interaction: { mode: "present" },
});

const testLayer = async (options: {
  readonly sessionIds?: ReadonlyArray<string>;
  readonly pointerIds?: ReadonlyArray<string>;
  readonly familyIds?: ReadonlyArray<string>;
  readonly pointerFailure?: boolean;
}) => {
  const root = await mkdtemp(join(tmpdir(), "cake-artifact-gc-"));
  roots.push(root);
  const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
  return {
    root,
    layer: Layer.mergeAll(
      makeArtifactStorageLive(join(root, "artifacts")).pipe(Layer.provide(platform)),
      makeArtifactProjectionLive(join(root, "cache")).pipe(Layer.provide(platform)),
      Layer.mock(PiSessions, {
        durableArtifactReferences: () =>
          options.pointerFailure
            ? Effect.fail(new PiSessionError({ operation: "scan", message: "uncertain" }))
            : Effect.succeed({
                sessionIds: options.sessionIds ?? [],
                lineageIds: options.pointerIds ?? [],
              }),
      }),
      Layer.mock(SessionFamilyStorage, {
        list: () =>
          Effect.succeed(
            (options.familyIds ?? []).map((familyId) => ({
              familyId,
              parentSessionId: `${familyId}-root`,
              projectPath: "/project",
              workingDirectory: "/project",
              createdAt: "2026-01-01T00:00:00.000Z",
              children: [],
            })),
          ),
      }),
      Layer.succeed(ProjectSessionConfiguration, {
        agentDirectory: "/agent",
        sessionDirectory: "/sessions",
        resolvedSessionDirectory: "/resolved",
      }),
    ),
  };
};

const publish = Effect.fn("Test.publishArtifact")(function* (
  lineageId: string,
  sessionId: string,
  target?: { type: "session"; sessionId: string } | { type: "family"; familyId: string },
) {
  const storage = yield* ArtifactStorage;
  const lineage = id(lineageId);
  if (target)
    return yield* storage.publishWithLink(
      {
        lineageId: lineage,
        expectedLatestRevision: 0,
        snapshot: snapshot(lineageId, sessionId),
        workingDirectory: "/project",
      },
      {
        lineageId: lineage,
        target,
        selection: { mode: "follow-latest" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    );
  return yield* storage.publish({
    lineageId: lineage,
    expectedLatestRevision: 0,
    snapshot: snapshot(lineageId, sessionId),
    workingDirectory: "/project",
  });
});

describe("artifact reachability garbage collection", () => {
  it.effect(
    "retains direct, surviving-family, and transcript-pointer lineages with full history",
    () =>
      Effect.gen(function* () {
        const { layer } = yield* Effect.promise(() =>
          testLayer({
            sessionIds: ["session-1", "family-1-root"],
            pointerIds: ["pointer"],
            familyIds: ["family-1"],
          }),
        );
        yield* Effect.gen(function* () {
          const direct = yield* publish("direct", "session-1", {
            type: "session",
            sessionId: "session-1",
          });
          yield* publish("family", "child", { type: "family", familyId: "family-1" });
          yield* publish("pointer", "deleted-session");
          const storage = yield* ArtifactStorage;
          yield* storage.publish({
            lineageId: direct.lineageId,
            expectedLatestRevision: 1,
            snapshot: snapshot("direct", "session-1", 2),
            workingDirectory: "/project",
          });

          const stats = yield* collectGarbage();
          expect(stats.lineagesRemoved).toBe(0);
          expect(
            (yield* storage.listRevisions(id("direct"))).map((item) => item.metadata.revision),
          ).toEqual([1, 2]);
          expect((yield* storage.catalog()).lineages.map((lineage) => lineage.id).sort()).toEqual([
            "direct",
            "family",
            "pointer",
          ]);
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "keeps a family link after one child disappears and collects it after the final family disappears",
    () =>
      Effect.gen(function* () {
        const active = yield* Effect.promise(() =>
          testLayer({ sessionIds: ["family-root"], familyIds: ["family"] }),
        );
        yield* Effect.gen(function* () {
          yield* publish("shared", "deleted-child", { type: "family", familyId: "family" });
          expect((yield* collectGarbage()).lineagesRemoved).toBe(0);
        }).pipe(Effect.provide(active.layer));

        const final = yield* Effect.promise(() => testLayer({}));
        yield* Effect.gen(function* () {
          yield* publish("shared", "deleted-child", { type: "family", familyId: "family" });
          expect((yield* collectGarbage()).lineagesRemoved).toBe(1);
        }).pipe(Effect.provide(final.layer));
      }),
  );

  it.effect("removes stale targets only after verified absence and is idempotent", () =>
    Effect.gen(function* () {
      const { layer } = yield* Effect.promise(() => testLayer({}));
      yield* Effect.gen(function* () {
        yield* publish("stale", "deleted", { type: "session", sessionId: "deleted" });
        const first = yield* collectGarbage();
        const second = yield* collectGarbage();
        expect(first).toMatchObject({ lineagesRemoved: 1, revisionsRemoved: 1, linksRemoved: 1 });
        expect(second).toMatchObject({ lineagesRemoved: 0, revisionsRemoved: 0, linksRemoved: 0 });
        expect((yield* (yield* ArtifactStorage).catalog()).lineages).toEqual([]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("fails closed when Pi pointer enumeration is uncertain", () =>
    Effect.gen(function* () {
      const { layer } = yield* Effect.promise(() => testLayer({ pointerFailure: true }));
      yield* Effect.gen(function* () {
        yield* publish("uncertain", "deleted");
        const result = yield* collectGarbage().pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect((yield* (yield* ArtifactStorage).catalog()).lineages).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("skips stale reachability decisions after concurrent publish and link mutations", () =>
    Effect.gen(function* () {
      const { layer } = yield* Effect.promise(() => testLayer({}));
      yield* Effect.gen(function* () {
        yield* publish("race", "session-1");
        const storage = yield* ArtifactStorage;
        const beforePublish = yield* storage.collectionSnapshot();
        yield* storage.publish({
          lineageId: id("race"),
          expectedLatestRevision: 1,
          snapshot: snapshot("race", "session-1", 2),
          workingDirectory: "/project",
        });
        const afterPublish = yield* storage.collectUnreachable({
          expectedCatalogToken: beforePublish.token,
          survivingSessionIds: [],
          survivingFamilyIds: [],
          transcriptLineageIds: [],
        });
        expect(afterPublish.skipped).toBe(true);

        const beforeLink = yield* storage.collectionSnapshot();
        yield* storage.putLink({
          lineageId: id("race"),
          target: { type: "session", sessionId: "session-1" },
          selection: { mode: "follow-latest" },
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        const afterLink = yield* storage.collectUnreachable({
          expectedCatalogToken: beforeLink.token,
          survivingSessionIds: [],
          survivingFamilyIds: [],
          transcriptLineageIds: [],
        });
        expect(afterLink.skipped).toBe(true);
        expect((yield* storage.catalog()).lineages).toHaveLength(1);
      }).pipe(Effect.provide(layer));
    }),
  );
});
