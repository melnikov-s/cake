import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactLineageId,
  ArtifactRevisionNumber,
} from "../../../../src/contracts/artifacts/artifact-lineage";
import type { CakeArtifactV1 } from "../../../../src/contracts/artifacts/artifact-contract";
import { ArtifactStorage } from "../../../../src/services/storage/ArtifactStorage";
import { makeArtifactStorageLive } from "../../../../src/services/storage/ArtifactStorageLive";

const directories: string[] = [];
const runtimes: Array<{ dispose: () => Promise<void> }> = [];
const lineageId = Schema.decodeUnknownSync(ArtifactLineageId);
const revision = Schema.decodeUnknownSync(ArtifactRevisionNumber);
const markdown = (id: string, number = 1): CakeArtifactV1 => ({
  protocol: "cake.artifact/v1",
  id,
  sessionId: "creator",
  revision: number,
  kind: "markdown",
  description: "Reusable team guide",
  payload: { markdown: `Guide ${number}` },
  fallback: { markdown: `Guide ${number}` },
});
const makeStorage = async () => {
  const root = await mkdtemp(join(tmpdir(), "cake-global-artifacts-"));
  directories.push(root);
  const runtime = ManagedRuntime.make(
    makeArtifactStorageLive(root).pipe(
      Layer.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
    ),
  );
  runtimes.push(runtime);
  return { root, storage: await runtime.runPromise(ArtifactStorage) };
};
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("global artifact storage", () => {
  it("retains global lineages and every revision after their creator and links are removed", async () => {
    const { storage } = await makeStorage();
    const id = lineageId("guide");
    await Effect.runPromise(
      storage.publishWithLink(
        {
          lineageId: id,
          global: true,
          expectedLatestRevision: 0,
          snapshot: markdown(id),
          workingDirectory: "/project",
        },
        {
          lineageId: id,
          target: { type: "session", sessionId: "creator" },
          selection: { mode: "follow-latest" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ),
    );
    await Effect.runPromise(
      storage.publish({
        lineageId: id,
        expectedLatestRevision: 1,
        snapshot: markdown(id, 2),
        workingDirectory: "/project",
      }),
    );
    const collect = async () => {
      const snapshot = await Effect.runPromise(storage.collectionSnapshot());
      return Effect.runPromise(
        storage.collectUnreachable({
          expectedCatalogToken: snapshot.token,
          survivingSessionIds: [],
          survivingFamilyIds: [],
          transcriptLineageIds: [],
        }),
      );
    };
    expect(await collect()).toMatchObject({
      lineagesRemoved: 0,
      revisionsRemoved: 0,
      linksRemoved: 1,
    });
    expect((await Effect.runPromise(storage.catalog())).lineages[0]?.global).toBe(true);
    expect((await Effect.runPromise(storage.read(id, revision(1))))?.metadata.description).toBe(
      "Reusable team guide",
    );
    expect(await Effect.runPromise(storage.listRevisions(id))).toHaveLength(2);
    await Effect.runPromise(storage.setArtifactGlobal(id, false));
    expect(await collect()).toMatchObject({
      lineagesRemoved: 1,
      revisionsRemoved: 2,
      blobsRemoved: 2,
    });
  });

  it("explicit deletion removes global widget links, state and boards, retaining shared browser output until its last use", async () => {
    const { root, storage } = await makeStorage();
    const browser = { digest: "b".repeat(64) };
    const output = join(root, "browser-outputs", browser.digest);
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "document.html"), "shared widget");
    for (const name of ["first", "second"]) {
      const id = lineageId(name);
      await Effect.runPromise(
        storage.publishWithLink(
          {
            lineageId: id,
            global: true,
            expectedLatestRevision: 0,
            snapshot: {
              protocol: "cake.artifact/v1",
              id,
              sessionId: "creator",
              revision: 1,
              kind: "widget",
              fallback: { markdown: name },
              payload: { language: "html", source: "<div/>", brief: name, browser },
            },
            workingDirectory: "/project",
            stagedState: { expectedVersion: 0, value: { count: 1 } },
          },
          {
            lineageId: id,
            target: { type: "session", sessionId: "creator" },
            selection: { mode: "follow-latest" },
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ),
      );
    }
    const boardDirectory = join(root, "boards", createHash("sha256").update("first").digest("hex"));
    await mkdir(boardDirectory, { recursive: true });
    await writeFile(join(boardDirectory, "entry.json"), "{}");
    const first = await Effect.runPromise(storage.read(lineageId("first")));
    await Effect.runPromise(storage.deleteArtifact(lineageId("first")));
    expect(await Effect.runPromise(storage.read(lineageId("first")))).toBeUndefined();
    expect(
      (await Effect.runPromise(storage.catalog())).links.map((link) => link.lineageId),
    ).toEqual(["second"]);
    await expect(readFile(join(root, "blobs", `${first?.metadata.digest}.json`))).rejects.toThrow();
    await expect(readFile(join(boardDirectory, "entry.json"))).rejects.toThrow();
    const persisted = JSON.parse(await readFile(join(root, "catalog.json"), "utf8"));
    expect(persisted.data.states.map((state: { lineageId: string }) => state.lineageId)).toEqual([
      "second",
    ]);
    expect(await readFile(join(output, "document.html"), "utf8")).toBe("shared widget");
    await Effect.runPromise(storage.deleteArtifact(lineageId("second")));
    await expect(readFile(join(output, "document.html"))).rejects.toThrow();
    expect(await Effect.runPromise(storage.catalog())).toEqual({ lineages: [], links: [] });
  });

  it("migrates version-four placement to ordinary without changing immutable blobs or widget state", async () => {
    const { root, storage } = await makeStorage();
    const id = lineageId("widget");
    const published = await Effect.runPromise(
      storage.publish({
        lineageId: id,
        expectedLatestRevision: 0,
        snapshot: {
          protocol: "cake.artifact/v1",
          id,
          sessionId: "creator",
          revision: 1,
          kind: "widget",
          fallback: { markdown: "Widget" },
          payload: {
            language: "html",
            source: "<div/>",
            brief: "Widget",
            browser: { digest: "b".repeat(64) },
          },
        },
        workingDirectory: "/project",
        stagedState: { expectedVersion: 0, value: { count: 42 } },
      }),
    );
    const catalogPath = join(root, "catalog.json");
    const old = JSON.parse(await readFile(catalogPath, "utf8"));
    old.version = 4;
    for (const lineage of old.data.lineages) delete lineage.global;
    await writeFile(catalogPath, JSON.stringify(old));
    expect((await Effect.runPromise(storage.catalog())).lineages[0]?.global).toBe(false);
    expect(await Effect.runPromise(storage.read(id))).toEqual(published);
    expect(await Effect.runPromise(storage.readState(id))).toMatchObject({
      version: 1,
      value: { count: 42 },
    });
    expect(JSON.parse(await readFile(catalogPath, "utf8")).version).toBe(5);
  });
});
