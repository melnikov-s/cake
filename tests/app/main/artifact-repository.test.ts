import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactRepository } from "../../../src/main/artifact-repository";

const directories: string[] = [];

afterEach(async () => Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("ArtifactRepository", () => {
  it("persists content-addressed payloads, enforces revisions, hydrates, and exports fallbacks", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-")); directories.push(root);
    const repository = new ArtifactRepository(root);
    const base = { protocol: "cake.artifact/v1" as const, id: "table-1", sessionId: "session-1", kind: "table" as const, title: "Scores", payload: { columns: [{ id: "score", label: "Score", type: "number" as const }], rows: [{ id: "one", score: 1 }], selectable: false }, fallback: { markdown: "| Score |\n| ---: |\n| 1 |" }, interaction: { mode: "present" as const } };
    const first = await repository.upsert("/project", { ...base, revision: 1 });
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    await expect(repository.upsert("/project", { ...base, revision: 3 })).rejects.toThrow("revision must advance");
    const second = await repository.upsert("/project", { ...base, revision: 2, payload: { ...base.payload, rows: [{ id: "one", score: 2 }] } });
    expect(second.createdAt).toBe(first.createdAt);
    expect((await new ArtifactRepository(root).listSession("/project", "session-1"))[0]?.artifact).toMatchObject({ id: "table-1", revision: 2 });
    expect(await repository.exportMarkdown("/project", "session-1")).toContain("| Score |");
  });

  it("serializes revision validation and writes for the same artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "cake-artifacts-")); directories.push(root);
    const repository = new ArtifactRepository(root);
    const base = { protocol: "cake.artifact/v1" as const, id: "table-1", sessionId: "session-1", kind: "table" as const, payload: { columns: [{ id: "value", label: "Value", type: "text" as const }], rows: [], selectable: false }, fallback: { markdown: "Empty" }, interaction: { mode: "present" as const } };
    await repository.upsert("/project", { ...base, revision: 1 });

    const results = await Promise.allSettled([
      repository.upsert("/project", { ...base, revision: 2, title: "First" }),
      repository.upsert("/project", { ...base, revision: 2, title: "Second" })
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect((await repository.get("/project", "session-1", "table-1"))?.artifact.revision).toBe(2);
  });
});
