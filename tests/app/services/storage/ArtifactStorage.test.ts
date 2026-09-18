import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactDigest,
  ArtifactLineageId,
  ArtifactRevisionNumber,
  formatArtifactRef,
  parseArtifactRef,
} from "../../../../src/domain/artifacts/artifact-lineage";
import type { CakeArtifactV1 } from "../../../../src/ipc/artifact-contract";
import {
  ArtifactPublicationConflict,
  ArtifactStorage,
} from "../../../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../../../src/services/storage/ArtifactStorageLive";

const directories: string[] = [];
const disposeRuntimes: Array<() => Promise<void>> = [];

const lineageId = (value: string) => Schema.decodeUnknownSync(ArtifactLineageId)(value);
const revision = (value: number) => Schema.decodeUnknownSync(ArtifactRevisionNumber)(value);
const digestValue = (value: string) => Schema.decodeUnknownSync(ArtifactDigest)(value);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

const makeStorage = async (root: string) => {
  const layer = makeArtifactStorageLive(root).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  );
  const runtime = ManagedRuntime.make(layer);
  disposeRuntimes.push(() => runtime.dispose());
  return runtime.runPromise(ArtifactStorage);
};

const tableSnapshot = (
  value: number,
  options: { id?: string; sessionId?: string; revision?: number; kind?: "table" | "request" } = {},
): CakeArtifactV1 =>
  options.kind === "request"
    ? {
        protocol: "cake.artifact/v1",
        id: options.id ?? "scores",
        sessionId: options.sessionId ?? "session-1",
        revision: options.revision ?? 1,
        kind: "request",
        payload: { request: { value } },
        fallback: { markdown: `Request ${value}` },
        interaction: { mode: "request" },
      }
    : {
        protocol: "cake.artifact/v1",
        id: options.id ?? "scores",
        sessionId: options.sessionId ?? "session-1",
        revision: options.revision ?? 1,
        kind: "table",
        title: `Scores ${value}`,
        payload: {
          columns: [{ id: "score", label: "Score", type: "number" }],
          rows: [{ id: "one", score: value }],
        },
        fallback: { markdown: `| Score |\n| ---: |\n| ${value} |` },
        interaction: { mode: "present" },
      };

afterEach(async () => {
  await Promise.all(disposeRuntimes.splice(0).map((dispose) => dispose()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const temporaryRoot = async () => {
  const state = await mkdtemp(join(tmpdir(), "cake-artifact-lineages-"));
  directories.push(state);
  return { state, root: join(state, "artifacts") };
};

describe("artifact lineage references", () => {
  it("formats and parses stable lineage and exact revision references", () => {
    const id = lineageId("runtime-overview");
    expect(formatArtifactRef({ lineageId: id })).toBe("cake://artifact/runtime-overview");
    const exact = formatArtifactRef({ lineageId: id, revision: revision(12) });
    expect(exact).toBe("cake://artifact/runtime-overview@r12");
    expect(parseArtifactRef(exact)).toEqual({ lineageId: id, revision: 12 });
    expect(() => parseArtifactRef("cake://artifact/runtime-overview@r0")).toThrow();
  });
});

describe("ArtifactStorage", () => {
  it("publishes immutable revisions, supports exact reads and rejects stale CAS", async () => {
    const { root } = await temporaryRoot();
    const storage = await makeStorage(root);
    const id = lineageId("scores");

    const first = await Effect.runPromise(
      storage.publish({
        lineageId: id,
        expectedLatestRevision: 0,
        snapshot: tableSnapshot(1),
        workingDirectory: "/project",
      }),
    );
    const second = await Effect.runPromise(
      storage.publish({
        lineageId: id,
        expectedLatestRevision: 1,
        snapshot: tableSnapshot(2, { revision: 2, sessionId: "session-2" }),
        workingDirectory: "/other-worktree",
        restoredFromRevision: revision(1),
      }),
    );

    expect((await Effect.runPromise(storage.read(id)))?.snapshot.title).toBe("Scores 2");
    expect((await Effect.runPromise(storage.read(id, revision(1))))?.snapshot.title).toBe(
      "Scores 1",
    );
    expect(
      (await Effect.runPromise(storage.listRevisions(id))).map((item) => item.metadata.revision),
    ).toEqual([1, 2]);
    expect(second.metadata.restoredFromRevision).toBe(1);
    expect(first.metadata.digest).not.toBe(second.metadata.digest);

    const conflict = await Effect.runPromise(
      Effect.flip(
        storage.publish({
          lineageId: id,
          expectedLatestRevision: 1,
          snapshot: tableSnapshot(3, { revision: 2 }),
          workingDirectory: "/project",
        }),
      ),
    );
    expect(conflict).toBeInstanceOf(ArtifactPublicationConflict);
    expect(conflict).toMatchObject({ expectedLatestRevision: 1, actualLatestRevision: 2 });
  });

  it("resolves session and family links as follow-latest or pinned without copying blobs", async () => {
    const { root } = await temporaryRoot();
    const storage = await makeStorage(root);
    const id = lineageId("scores");
    await Effect.runPromise(
      storage.publish({
        lineageId: id,
        expectedLatestRevision: 0,
        snapshot: tableSnapshot(1),
        workingDirectory: "/project",
      }),
    );
    await Effect.runPromise(
      storage.putLink({
        lineageId: id,
        target: { type: "session", sessionId: "session-1" },
        selection: { mode: "follow-latest" },
        createdAt: new Date(0).toISOString(),
      }),
    );
    await Effect.runPromise(
      storage.putLink({
        lineageId: id,
        target: { type: "family", familyId: "family-1" },
        selection: { mode: "pinned", revision: revision(1) },
        createdAt: new Date(0).toISOString(),
      }),
    );
    await Effect.runPromise(
      storage.publish({
        lineageId: id,
        expectedLatestRevision: 1,
        snapshot: tableSnapshot(2, { revision: 2, sessionId: "session-2" }),
        workingDirectory: "/project",
      }),
    );

    const session = await Effect.runPromise(
      storage.resolveLinks({ type: "session", sessionId: "session-1" }),
    );
    const family = await Effect.runPromise(
      storage.resolveLinks({ type: "family", familyId: "family-1" }),
    );
    expect(session[0]?.metadata.revision).toBe(2);
    expect(family[0]?.metadata.revision).toBe(1);
    expect(await readdir(join(root, "blobs"))).toHaveLength(2);
  });

  it("validates digests and removes only unreferenced orphan blobs", async () => {
    const { root } = await temporaryRoot();
    const storage = await makeStorage(root);
    const id = lineageId("scores");
    const published = await Effect.runPromise(
      storage.publish({
        lineageId: id,
        expectedLatestRevision: 0,
        snapshot: tableSnapshot(1),
        workingDirectory: "/project",
      }),
    );
    expect(await Effect.runPromise(storage.deleteBlobIfOrphaned(published.metadata.digest))).toBe(
      false,
    );

    const orphanContent = "orphan";
    const orphanDigest = digestValue(hash(orphanContent));
    await writeFile(join(root, "blobs", `${orphanDigest}.json`), orphanContent);
    expect(await Effect.runPromise(storage.deleteBlobIfOrphaned(orphanDigest))).toBe(true);

    await writeFile(join(root, "blobs", `${published.metadata.digest}.json`), "corrupt");
    await expect(Effect.runPromise(storage.read(id))).rejects.toThrow("digest does not match");
  });

  it("retains a blob shared by a retained revision while collecting another lineage", async () => {
    const { root } = await temporaryRoot();
    const storage = await makeStorage(root);
    const retained = await Effect.runPromise(
      storage.publishWithLink(
        {
          lineageId: lineageId("retained"),
          expectedLatestRevision: 0,
          snapshot: tableSnapshot(1, { id: "retained" }),
          workingDirectory: "/project",
        },
        {
          lineageId: lineageId("retained"),
          target: { type: "session", sessionId: "surviving" },
          selection: { mode: "follow-latest" },
          createdAt: new Date(0).toISOString(),
        },
      ),
    );
    await Effect.runPromise(
      storage.publish({
        lineageId: lineageId("removed"),
        expectedLatestRevision: 0,
        snapshot: tableSnapshot(2, { id: "removed" }),
        workingDirectory: "/project",
      }),
    );
    // Exercise the collector's digest-level invariant directly. Normal publication
    // embeds identity in the blob, but migrated/catalog-level data may still share a digest.
    const catalogPath = join(root, "catalog.json");
    const envelope = JSON.parse(await readFile(catalogPath, "utf8"));
    envelope.data.lineages.find(
      (item: { id: string }) => item.id === "removed",
    ).revisions[0].digest = retained.metadata.digest;
    await writeFile(catalogPath, `${JSON.stringify(envelope, null, 2)}\n`);

    const before = await Effect.runPromise(storage.collectionSnapshot());
    const stats = await Effect.runPromise(
      storage.collectUnreachable({
        expectedCatalogToken: before.token,
        survivingSessionIds: ["surviving"],
        survivingFamilyIds: [],
        transcriptLineageIds: [],
      }),
    );
    expect(stats.lineagesRemoved).toBe(1);
    expect(
      await readFile(join(root, "blobs", `${retained.metadata.digest}.json`), "utf8"),
    ).toContain('"id": "retained"');
  });

  it("migrates legacy revisions and fork links once while excluding request records", async () => {
    const { state, root } = await temporaryRoot();
    const blobs = join(root, "blobs");
    const sessions = join(root, "sessions");
    await mkdir(blobs, { recursive: true });

    const first = tableSnapshot(1);
    const second = tableSnapshot(2, { revision: 2 });
    const request = tableSnapshot(0, { id: "blocking", kind: "request" });
    const writeBlob = async (snapshot: CakeArtifactV1) => {
      const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
      const value = hash(serialized);
      await writeFile(join(blobs, `${value}.json`), serialized);
      return value;
    };
    const firstDigest = await writeBlob(first);
    const secondDigest = await writeBlob(second);
    const requestDigest = await writeBlob(request);
    const writeIndex = async (targetSessionId: string, snapshot: CakeArtifactV1, value: string) => {
      const directory = join(sessions, hash("/project"), hash(targetSessionId));
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, `${hash(snapshot.id)}.json`),
        `${JSON.stringify(
          {
            protocol: "cake.artifact/v1",
            id: snapshot.id,
            sessionId: snapshot.sessionId,
            workspacePath: "/project",
            revision: snapshot.revision,
            kind: snapshot.kind,
            digest: value,
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(1).toISOString(),
          },
          null,
          2,
        )}\n`,
      );
    };
    await writeIndex("session-1", second, secondDigest);
    await writeIndex("fork-1", first, firstDigest);
    await writeIndex("session-1", request, requestDigest);
    await writeFile(
      join(state, "session-families.json"),
      `${JSON.stringify({
        version: 5,
        data: {
          families: [
            {
              familyId: "family-1",
              parentSessionId: "session-1",
              children: [{ sessionId: "fork-1" }],
            },
          ],
        },
      })}\n`,
    );

    const storage = await makeStorage(root);
    const catalog = await Effect.runPromise(storage.catalog());
    expect(catalog.lineages).toHaveLength(1);
    expect(catalog.lineages[0]?.revisions.map((item) => item.revision)).toEqual([1, 2]);
    expect(catalog.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          target: { type: "session", sessionId: "session-1" },
          selection: { mode: "follow-latest" },
        }),
        expect.objectContaining({
          target: { type: "session", sessionId: "fork-1" },
          selection: { mode: "pinned", revision: 1 },
        }),
      ]),
    );
    expect(JSON.parse(await readFile(join(root, "catalog.json"), "utf8")).version).toBe(2);

    await rm(join(root, "sessions"), { recursive: true });
    const reloaded = await makeStorage(root);
    expect((await Effect.runPromise(reloaded.catalog())).lineages).toHaveLength(1);
  });

  it("fails migration rather than accepting a corrupt legacy blob", async () => {
    const { root } = await temporaryRoot();
    await mkdir(join(root, "blobs"), { recursive: true });
    await writeFile(join(root, "blobs", `${"a".repeat(64)}.json`), "{}\n");
    const storage = await makeStorage(root);
    await expect(Effect.runPromise(storage.catalog())).rejects.toThrow("invalid digest");
  });
});
