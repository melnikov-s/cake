import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeArtifactStorageTestAdapter } from "../../../../src/services/storage/ArtifactStorageLive";

const directories: string[] = [];

afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

async function seedHistoricalArchitecture(root: string) {
  const artifact = {
    protocol: "cake.artifact/v1",
    id: "architecture-1",
    sessionId: "session-1",
    revision: 1,
    kind: "architecture",
    title: "Runtime architecture",
    payload: {
      nodes: [
        { id: "renderer", label: "Renderer" },
        { id: "main", label: "Main" },
      ],
      edges: [{ id: "rpc", source: "renderer", target: "main", label: "RPC" }],
    },
    fallback: { markdown: "Renderer communicates with main." },
    interaction: { mode: "present" },
  };
  const serialized = `${JSON.stringify(artifact, null, 2)}\n`;
  const digest = createHash("sha256").update(serialized).digest("hex");
  const digestKey = (value: string) => createHash("sha256").update(value).digest("hex");
  const blobPath = join(root, "blobs", `${digest}.json`);
  const recordDirectory = join(root, "sessions", digestKey("/project"), digestKey("session-1"));
  await mkdir(join(root, "blobs"), { recursive: true });
  await mkdir(recordDirectory, { recursive: true });
  await writeFile(blobPath, serialized);
  await writeFile(
    join(recordDirectory, `${digestKey("architecture-1")}.json`),
    `${JSON.stringify(
      {
        protocol: "cake.artifact/v1",
        id: artifact.id,
        sessionId: artifact.sessionId,
        workspacePath: "/project",
        revision: artifact.revision,
        kind: artifact.kind,
        digest,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return { blobPath, digest, serialized };
}

const baseArtifact = {
  protocol: "cake.artifact/v1" as const,
  id: "table-1",
  sessionId: "session-1",
  kind: "table" as const,
  payload: {
    columns: [{ id: "score", label: "Score", type: "number" as const }],
    rows: [{ id: "one", score: 1 }],
    selectable: false,
  },
  fallback: { markdown: "| Score |\n| ---: |\n| 1 |" },
  interaction: { mode: "present" as const },
};

describe("ArtifactStorage", () => {
  it("projects historical architecture blobs to readable Markdown without rewriting storage", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-"));
    directories.push(root);
    const historical = await seedHistoricalArchitecture(root);
    const storage = makeArtifactStorageTestAdapter(root).service;

    const record = await Effect.runPromise(storage.get("/project", "session-1", "architecture-1"));
    expect(record).toMatchObject({
      digest: historical.digest,
      artifact: {
        id: "architecture-1",
        kind: "markdown",
        payload: { markdown: "Renderer communicates with main." },
      },
    });
    expect(await Effect.runPromise(storage.listSession("/project", "session-1"))).toHaveLength(1);
    expect(await Effect.runPromise(storage.exportMarkdown("/project", "session-1"))).toContain(
      "Renderer communicates with main.",
    );
    expect(await readFile(historical.blobPath, "utf8")).toBe(historical.serialized);
  });

  it("verifies historical architecture pointers while inheriting a fork", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-"));
    directories.push(root);
    const historical = await seedHistoricalArchitecture(root);
    const storage = makeArtifactStorageTestAdapter(root).service;

    await Effect.runPromise(
      storage.inheritFork("/project", "session-1", "/project", "fork-1", [
        {
          protocol: "cake.artifact/v1",
          artifactId: "architecture-1",
          sessionId: "session-1",
          revision: 1,
          kind: "architecture",
          digest: historical.digest,
          fallback: { markdown: "Renderer communicates with main." },
        },
      ]),
    );

    const inherited = await Effect.runPromise(storage.listSession("/project", "fork-1"));
    expect(inherited[0]).toMatchObject({
      digest: historical.digest,
      artifact: { id: "architecture-1", kind: "markdown" },
    });
    expect(await readFile(historical.blobPath, "utf8")).toBe(historical.serialized);

    await expect(
      Effect.runPromise(
        storage.inheritFork("/project", "session-1", "/project", "invalid-fork", [
          {
            protocol: "cake.artifact/v1",
            artifactId: "architecture-1",
            sessionId: "session-1",
            revision: 1,
            kind: "markdown",
            digest: historical.digest,
            fallback: { markdown: "Renderer communicates with main." },
          },
        ]),
      ),
    ).rejects.toThrow("does not match its source pointer");
    expect(await Effect.runPromise(storage.listSession("/project", "invalid-fork"))).toEqual([]);
  });

  it("persists content-addressed payloads, enforces revisions, hydrates, and exports fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-"));
    directories.push(root);
    const storage = makeArtifactStorageTestAdapter(root).service;
    const first = await Effect.runPromise(
      storage.upsert("/project", { ...baseArtifact, revision: 1, title: "Scores" }),
    );
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      Effect.runPromise(storage.upsert("/project", { ...baseArtifact, revision: 3 })),
    ).rejects.toThrow("revision must advance");
    const second = await Effect.runPromise(
      storage.upsert("/project", {
        ...baseArtifact,
        revision: 2,
        payload: { ...baseArtifact.payload, rows: [{ id: "one", score: 2 }] },
      }),
    );
    expect(second.createdAt).toBe(first.createdAt);
    const reloaded = makeArtifactStorageTestAdapter(root).service;
    expect(
      (await Effect.runPromise(reloaded.listSession("/project", "session-1")))[0]?.artifact,
    ).toMatchObject({ id: "table-1", revision: 2 });
    expect(await Effect.runPromise(storage.exportMarkdown("/project", "session-1"))).toContain(
      "| Score |",
    );
    await Effect.runPromise(storage.deleteSession("/project", "session-1"));
    expect(await Effect.runPromise(storage.listSession("/project", "session-1"))).toEqual([]);
  });

  it("freezes fork associations at the revisions reachable from the fork entry", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-"));
    directories.push(root);
    const storage = makeArtifactStorageTestAdapter(root).service;
    const first = await Effect.runPromise(
      storage.upsert("/project", { ...baseArtifact, revision: 1, title: "At fork" }),
    );

    await Effect.runPromise(
      storage.upsert("/project", { ...baseArtifact, revision: 2, title: "After fork entry" }),
    );
    await Effect.runPromise(
      storage.upsert("/project", {
        ...baseArtifact,
        id: "later-artifact",
        revision: 1,
        title: "Created later",
      }),
    );
    await Effect.runPromise(
      storage.inheritFork("/project", "session-1", "/project", "fork-1", [
        {
          protocol: "cake.artifact/v1",
          artifactId: first.artifact.id,
          sessionId: first.artifact.sessionId,
          revision: first.artifact.revision,
          kind: first.artifact.kind,
          digest: first.digest,
          fallback: first.artifact.fallback,
        },
      ]),
    );

    const inherited = await Effect.runPromise(storage.listSession("/project", "fork-1"));
    expect(inherited).toHaveLength(1);
    expect(inherited[0]?.artifact).toMatchObject({ id: "table-1", revision: 1, title: "At fork" });

    await Effect.runPromise(storage.deleteSession("/project", "session-1"));
    expect(
      (await Effect.runPromise(storage.get("/project", "fork-1", "table-1")))?.artifact.revision,
    ).toBe(1);
    await Effect.runPromise(storage.deleteSession("/project", "fork-1"));
    expect(await Effect.runPromise(storage.listSession("/project", "fork-1"))).toEqual([]);
  });

  it("rejects fork associations that do not match the source snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-"));
    directories.push(root);
    const storage = makeArtifactStorageTestAdapter(root).service;
    const first = await Effect.runPromise(
      storage.upsert("/project", { ...baseArtifact, revision: 1 }),
    );

    await expect(
      Effect.runPromise(
        storage.inheritFork("/project", "session-1", "/project", "fork-1", [
          {
            protocol: "cake.artifact/v1",
            artifactId: first.artifact.id,
            sessionId: first.artifact.sessionId,
            revision: first.artifact.revision,
            kind: first.artifact.kind,
            digest: "f".repeat(64),
            fallback: first.artifact.fallback,
          },
        ]),
      ),
    ).rejects.toThrow();
    expect(await Effect.runPromise(storage.listSession("/project", "fork-1"))).toEqual([]);
  });

  it("serializes revision validation and writes for the same artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-"));
    directories.push(root);
    const storage = makeArtifactStorageTestAdapter(root).service;
    await Effect.runPromise(storage.upsert("/project", { ...baseArtifact, revision: 1 }));

    const results = await Promise.allSettled([
      Effect.runPromise(
        storage.upsert("/project", { ...baseArtifact, revision: 2, title: "First" }),
      ),
      Effect.runPromise(
        storage.upsert("/project", { ...baseArtifact, revision: 2, title: "Second" }),
      ),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(
      (await Effect.runPromise(storage.get("/project", "session-1", "table-1")))?.artifact.revision,
    ).toBe(2);
  });
});
