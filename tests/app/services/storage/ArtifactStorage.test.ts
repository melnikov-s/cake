import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeArtifactStorageLive } from "../../../../src/services/storage/ArtifactStorageLive";

const directories: string[] = [];

afterEach(async () =>
  Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))),
);

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
  it("persists content-addressed payloads, enforces revisions, hydrates, and exports fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-"));
    directories.push(root);
    const storage = makeArtifactStorageLive(root).service;
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
    const reloaded = makeArtifactStorageLive(root).service;
    expect(
      (await Effect.runPromise(reloaded.listSession("/project", "session-1")))[0]?.artifact,
    ).toMatchObject({ id: "table-1", revision: 2 });
    expect(await Effect.runPromise(storage.exportMarkdown("/project", "session-1"))).toContain(
      "| Score |",
    );
    await Effect.runPromise(storage.deleteSession("/project", "session-1"));
    expect(await Effect.runPromise(storage.listSession("/project", "session-1"))).toEqual([]);
  });

  it("serializes revision validation and writes for the same artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-"));
    directories.push(root);
    const storage = makeArtifactStorageLive(root).service;
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
