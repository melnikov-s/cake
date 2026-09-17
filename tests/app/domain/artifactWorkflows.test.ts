import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactLineageId,
  ArtifactRevisionNumber,
  formatArtifactRef,
} from "../../../src/domain/artifacts/artifact-lineage";
import * as artifacts from "../../../src/domain/artifacts/artifacts";
import * as workflows from "../../../src/domain/artifacts/artifactWorkflows";
import type { CakeArtifactV1 } from "../../../src/ipc/artifact-contract";
import {
  ArtifactPublicationConflict,
  ArtifactStorage,
} from "../../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../../src/services/storage/ArtifactStorageLive";
import {
  SessionFamilyStorage,
  SessionFamilyStorageError,
  type SessionFamily,
} from "../../../src/services/storage/SessionFamilyStorage";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const lineageId = (value: string) => Schema.decodeUnknownSync(ArtifactLineageId)(value);
const revision = (value: number) => Schema.decodeUnknownSync(ArtifactRevisionNumber)(value);
const snapshot = (
  id: string,
  sessionId: string,
  revisionNumber: number,
  markdown: string,
): CakeArtifactV1 => ({
  protocol: "cake.artifact/v1",
  id,
  sessionId,
  revision: revisionNumber,
  kind: "markdown",
  payload: { markdown },
  fallback: { markdown },
  interaction: { mode: "present" },
});

const family = (children: ReadonlyArray<string>): SessionFamily => ({
  familyId: "family-1",
  parentSessionId: "parent",
  projectPath: "/project",
  workingDirectory: "/project",
  createdAt: "2026-01-01T00:00:00.000Z",
  children: children.map((sessionId, index) => ({
    sessionId,
    parentSessionId: "parent",
    requestId: `request-${index}`,
    workingDirectory: "/project",
    createdAt: `2026-01-01T00:00:0${index + 1}.000Z`,
  })),
});

const makeLayer = async (
  getFamilies: () => ReadonlyArray<SessionFamily>,
  getLookupFailure: () => SessionFamilyStorageError | undefined = () => undefined,
) => {
  const root = await mkdtemp(join(tmpdir(), "cake-artifact-workflows-"));
  directories.push(root);
  const storage = makeArtifactStorageLive(join(root, "artifacts")).pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  );
  const membership = Layer.mock(SessionFamilyStorage, {
    withMemberLock: (_sessionId, effect) => effect,
    familyForMember: (sessionId) => {
      const lookupFailure = getLookupFailure();
      return lookupFailure
        ? Effect.fail(lookupFailure)
        : Effect.succeed(
            getFamilies().find(
              (candidate) =>
                candidate.parentSessionId === sessionId ||
                candidate.children.some((child) => child.sessionId === sessionId),
            ),
          );
    },
  });
  return Layer.merge(storage, membership);
};

const visible = (sessionId: string) =>
  workflows
    .listEffectiveSessionArtifacts(sessionId)
    .pipe(
      Effect.map((items) =>
        items.map(({ revision: item }) => `${item.lineageId}@r${item.metadata.revision}`),
      ),
    );

describe("artifact lineage workflows", () => {
  it("shares parent and child creations across the current family and future descendants", async () => {
    let currentFamily = family(["child", "sibling"]);
    const layer = await makeLayer(() => [currentFamily]);

    await Effect.runPromise(
      Effect.gen(function* () {
        yield* workflows.create({
          sessionId: "parent",
          lineageId: lineageId("parent-plan"),
          snapshot: snapshot("parent-plan", "parent", 1, "parent content"),
          workingDirectory: "/project",
        });
        expect(yield* visible("child")).toEqual(["parent-plan@r1"]);
        expect(yield* visible("sibling")).toEqual(["parent-plan@r1"]);
        expect(yield* visible("unrelated")).toEqual([]);

        yield* workflows.create({
          sessionId: "child",
          lineageId: lineageId("child-plan"),
          snapshot: snapshot("child-plan", "child", 1, "child content"),
          workingDirectory: "/project",
        });
        expect(yield* visible("parent")).toEqual(["parent-plan@r1", "child-plan@r1"]);
        expect(yield* visible("sibling")).toEqual(["parent-plan@r1", "child-plan@r1"]);

        currentFamily = family(["child", "sibling", "future-child"]);
        expect(yield* visible("future-child")).toEqual(["parent-plan@r1", "child-plan@r1"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("uses direct standalone links and supports explicit session and family links", async () => {
    const layer = await makeLayer(() => [family(["family-child"])]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const id = lineageId("standalone-plan");
        yield* workflows.create({
          sessionId: "standalone",
          lineageId: id,
          snapshot: snapshot(id, "standalone", 1, "one"),
          workingDirectory: "/project",
        });
        expect(yield* visible("standalone")).toEqual(["standalone-plan@r1"]);
        expect(yield* visible("other")).toEqual([]);

        yield* workflows.linkSession(id, "other");
        yield* workflows.linkFamily(id, "family-1");
        expect(yield* visible("other")).toEqual(["standalone-plan@r1"]);
        expect(yield* visible("family-child")).toEqual(["standalone-plan@r1"]);

        const links = yield* workflows.listLineageLinks(id);
        expect(links.map((link) => link.target.type).sort()).toEqual([
          "family",
          "session",
          "session",
        ]);

        yield* workflows.unlinkSession(id, "other");
        yield* workflows.unlinkFamily(id, "family-1");
        expect(yield* visible("other")).toEqual([]);
        expect(yield* visible("family-child")).toEqual([]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("resolves follow-latest and pinned links and lets any effectively linked session publish", async () => {
    const layer = await makeLayer(() => []);
    await Effect.runPromise(
      Effect.gen(function* () {
        const id = lineageId("revisions");
        yield* workflows.create({
          sessionId: "author",
          lineageId: id,
          snapshot: snapshot(id, "author", 1, "one"),
          workingDirectory: "/project",
        });
        yield* workflows.linkSession(id, "pinned", { mode: "pinned", revision: revision(1) });
        yield* workflows.linkSession(id, "latest");
        yield* workflows.publish({
          sessionId: "latest",
          lineageId: id,
          expectedLatestRevision: 1,
          snapshot: snapshot(id, "latest", 2, "two"),
          workingDirectory: "/project",
        });
        expect(yield* visible("pinned")).toEqual(["revisions@r1"]);
        expect(yield* visible("latest")).toEqual(["revisions@r2"]);

        yield* workflows.setSelection(
          id,
          { type: "session", sessionId: "pinned" },
          {
            mode: "follow-latest",
          },
        );
        expect(yield* visible("pinned")).toEqual(["revisions@r2"]);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("restores historical content as N+1 and preserves exact history metadata", async () => {
    const layer = await makeLayer(() => []);
    await Effect.runPromise(
      Effect.gen(function* () {
        const id = lineageId("restore-plan");
        yield* workflows.create({
          sessionId: "author",
          lineageId: id,
          snapshot: snapshot(id, "author", 1, "one"),
          workingDirectory: "/project",
        });
        yield* workflows.publish({
          sessionId: "author",
          lineageId: id,
          expectedLatestRevision: 1,
          snapshot: snapshot(id, "author", 2, "two"),
          workingDirectory: "/project",
        });
        const restored = yield* workflows.restore({
          sessionId: "author",
          lineageId: id,
          sourceRevision: revision(1),
          expectedLatestRevision: 2,
          workingDirectory: "/project",
        });
        expect(restored.metadata.revision).toBe(3);
        expect(restored.metadata.restoredFromRevision).toBe(1);
        expect(restored.snapshot.fallback.markdown).toBe("one");
        expect((yield* workflows.history(id)).map((item) => item.metadata.revision)).toEqual([
          1, 2, 3,
        ]);
        expect(
          (yield* workflows.readExactRevision(id, revision(2))).snapshot.fallback.markdown,
        ).toBe("two");
        const metadata = yield* workflows.resolveReferenceMetadata(
          formatArtifactRef({ lineageId: id, revision: revision(1) }),
        );
        expect(metadata.revision.revision).toBe(1);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("allows one concurrent publication and returns a typed conflict to the stale writer", async () => {
    const layer = await makeLayer(() => []);
    await Effect.runPromise(
      Effect.gen(function* () {
        const id = lineageId("conflict");
        yield* workflows.create({
          sessionId: "author",
          lineageId: id,
          snapshot: snapshot(id, "author", 1, "one"),
          workingDirectory: "/project",
        });
        const publish = (markdown: string) =>
          workflows
            .publish({
              sessionId: "author",
              lineageId: id,
              expectedLatestRevision: 1,
              snapshot: snapshot(id, "author", 2, markdown),
              workingDirectory: "/project",
            })
            .pipe(Effect.result);
        const outcomes = yield* Effect.all([publish("writer-a"), publish("writer-b")], {
          concurrency: "unbounded",
        });
        expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
        const failure = outcomes.find((outcome) => outcome._tag === "Failure");
        expect(failure?._tag === "Failure" ? failure.failure : undefined).toBeInstanceOf(
          ArtifactPublicationConflict,
        );
      }).pipe(Effect.provide(layer)),
    );
  });

  it("fails closed instead of degrading to direct visibility when family lookup fails", async () => {
    const lookupFailure = new SessionFamilyStorageError({
      operation: "familyForMember",
      message: "unavailable",
    });
    let unavailable = false;
    const layer = await makeLayer(
      () => [],
      () => (unavailable ? lookupFailure : undefined),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const id = lineageId("fail-closed");
        yield* workflows.create({
          sessionId: "author",
          lineageId: id,
          snapshot: snapshot(id, "author", 1, "one"),
          workingDirectory: "/project",
        });
        unavailable = true;
        const failure = yield* visible("author").pipe(Effect.flip);
        expect(failure).toBe(lookupFailure);
        expect((yield* (yield* ArtifactStorage).catalog()).lineages).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
    );
  });

  it("removes child direct links without removing family sharing, then removes final targets", async () => {
    const layer = await makeLayer(() => [family(["child", "sibling"])]);
    await Effect.runPromise(
      Effect.gen(function* () {
        const familyId = lineageId("family-plan");
        yield* workflows.create({
          sessionId: "child",
          lineageId: familyId,
          snapshot: snapshot(familyId, "child", 1, "family"),
          workingDirectory: "/project",
        });
        yield* workflows.linkSession(familyId, "child");
        yield* artifacts.deleteSession("/project", "child");
        expect(yield* visible("child")).toEqual(["family-plan@r1"]);
        expect(yield* visible("sibling")).toEqual(["family-plan@r1"]);
        yield* artifacts.deleteFamily("family-1");
        expect(yield* visible("child")).toEqual([]);
        expect(yield* visible("sibling")).toEqual([]);

        const standaloneId = lineageId("standalone-delete");
        yield* workflows.create({
          sessionId: "standalone",
          lineageId: standaloneId,
          snapshot: snapshot(standaloneId, "standalone", 1, "standalone"),
          workingDirectory: "/project",
        });
        yield* artifacts.deleteSession("/project", "standalone");
        expect(yield* visible("standalone")).toEqual([]);
        expect((yield* workflows.listGlobalLineages()).map((item) => item.id)).toEqual([
          "family-plan",
          "standalone-delete",
        ]);
      }).pipe(Effect.provide(layer)),
    );
  });
});
