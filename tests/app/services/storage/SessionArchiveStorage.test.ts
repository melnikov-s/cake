import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cakeWorkspaceSessionDirectory,
  streamWorkspaceSessions,
} from "../../../../src/services/pi/runtime/session-discovery";
import { SessionArchiveStorage } from "../../../../src/services/storage/SessionArchiveStorage";
import { makeSessionArchiveStorageLive } from "../../../../src/services/storage/SessionArchiveStorageLive";

let metadataRoot = "";

const runArchive = <A, E>(
  use: (storage: SessionArchiveStorage["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.runPromise(
    Effect.flatMap(SessionArchiveStorage, use).pipe(
      Effect.provide(makeSessionArchiveStorageLive(join(metadataRoot, "archive"))),
    ),
  );

const directories: string[] = [];

beforeEach(async () => {
  metadataRoot = await mkdtemp(join(tmpdir(), "cake-session-archive-metadata-"));
  directories.push(metadataRoot);
});

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "cake-session-archive-"));
  directories.push(cwd);
  const activeRoot = join(cwd, "active");
  const resolvedRoot = join(cwd, "resolved");
  const activeDirectory = cakeWorkspaceSessionDirectory(cwd, activeRoot);
  const timestamp = new Date().toISOString();
  await mkdir(activeDirectory, { recursive: true });
  await writeFile(
    join(activeDirectory, "2026-01-01T00-00-00-000Z_session-1.jsonl"),
    [
      { type: "session", version: 3, id: "session-1", timestamp, cwd },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Archived work", timestamp: Date.now() },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  return { cwd, activeRoot, resolvedRoot };
}

describe("SessionArchiveStorage", () => {
  it("lazily indexes legacy project archives from Pi transcripts", async () => {
    const location = await fixture();
    await runArchive((storage) => storage.resolve("session-1", location));

    await expect(
      runArchive((storage) => storage.projectMigrationComplete("/projects/cake")),
    ).resolves.toBe(false);
    await expect(
      runArchive((storage) =>
        storage
          .migrateProject("/projects/cake", "Cake", [{ location, worktreeName: "legacy-worktree" }])
          .pipe(Stream.runCollect),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        worktreeName: "legacy-worktree",
      }),
    ]);
    await expect(
      runArchive((storage) => storage.projectMigrationComplete("/projects/cake")),
    ).resolves.toBe(true);
    await expect(
      runArchive((storage) =>
        storage.migrateProject("/projects/cake", "Cake", [{ location }]).pipe(Stream.runCollect),
      ),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        worktreeName: "legacy-worktree",
      }),
    ]);
  });

  it("lists project archives from Pi transcripts and restores with one file move", async () => {
    const location = await fixture();

    await runArchive((storage) =>
      storage.resolveProject("session-1", location, {
        projectPath: "/projects/cake",
        projectName: "Cake",
        worktreeName: "archive-index",
      }),
    );
    await expect(
      runArchive((storage) => storage.resolvedProjects("/projects/cake").pipe(Stream.runCollect)),
    ).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        worktreeName: "archive-index",
      }),
    ]);

    await expect(runArchive((storage) => storage.restoreProject("session-1"))).resolves.toEqual(
      expect.objectContaining({ sessionId: "session-1" }),
    );
    await expect(
      runArchive((storage) => storage.resolvedProjects("/projects/cake").pipe(Stream.runCollect)),
    ).resolves.toEqual([]);
    expect(
      await Effect.runPromise(
        streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
      ),
    ).toEqual([expect.objectContaining({ id: "session-1" })]);
  });

  it("preserves Pi titles across resolve and restore", async () => {
    const location = await fixture();

    await runArchive((storage) => storage.resolve("session-1", location));
    await expect(
      runArchive((storage) => storage.resolvedEntry("session-1", location)),
    ).resolves.toEqual(expect.objectContaining({ title: "Archived work" }));
    await runArchive((storage) => storage.restore("session-1", location));

    await expect(
      Effect.runPromise(
        streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
      ),
    ).resolves.toEqual([expect.objectContaining({ title: "Archived work" })]);
  });
  it("moves a project session out of Pi's active root and restores it", async () => {
    const location = await fixture();
    await expect(runArchive((storage) => storage.resolve("session-1", location))).resolves.toBe(
      true,
    );
    await expect(runArchive((storage) => storage.resolve("session-1", location))).resolves.toBe(
      false,
    );
    expect(
      await Effect.runPromise(
        streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
      ),
    ).toEqual([]);
    expect(
      await runArchive((storage) => storage.resolved(location).pipe(Stream.runCollect)),
    ).toEqual([expect.objectContaining({ id: "session-1", resolved: true })]);
    await expect(
      runArchive((storage) => storage.resolvedEntry("session-1", location)),
    ).resolves.toEqual(expect.objectContaining({ id: "session-1", resolved: true }));

    await expect(runArchive((storage) => storage.restore("session-1", location))).resolves.toBe(
      true,
    );
    await expect(runArchive((storage) => storage.restore("session-1", location))).resolves.toBe(
      false,
    );
    expect(
      await Effect.runPromise(
        streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
      ),
    ).toEqual([expect.objectContaining({ id: "session-1", resolved: false })]);
  });

  it("treats concurrent archive requests as one idempotent move", async () => {
    const location = await fixture();
    const outcomes = await Promise.all([
      runArchive((storage) => storage.resolve("session-1", location)),
      runArchive((storage) => storage.resolve("session-1", location)),
    ]);

    expect(outcomes.sort()).toEqual([false, true]);
    expect(
      await Effect.runPromise(
        streamWorkspaceSessions(location.cwd, location.activeRoot).pipe(Stream.runCollect),
      ),
    ).toEqual([]);
    expect(
      await runArchive((storage) => storage.resolved(location).pipe(Stream.runCollect)),
    ).toEqual([expect.objectContaining({ id: "session-1", resolved: true })]);
  });

  it("permanently deletes a transcript from either namespace", async () => {
    const activeLocation = await fixture();
    const resolvedLocation = await fixture();
    await runArchive((storage) => storage.resolve("session-1", resolvedLocation));

    await expect(
      runArchive((storage) => storage.delete("session-1", activeLocation)),
    ).resolves.toBeUndefined();
    await expect(
      runArchive((storage) => storage.delete("session-1", resolvedLocation)),
    ).resolves.toBeUndefined();
    await expect(
      runArchive((storage) => storage.delete("session-1", activeLocation)),
    ).rejects.toThrow("Cake could not find session session-1");
  });

  it("permanently deletes only a resolved transcript", async () => {
    const location = await fixture();
    await expect(
      runArchive((storage) => storage.deleteResolved("session-1", location)),
    ).rejects.toThrow("Cake could not find resolved session session-1");
    await runArchive((storage) => storage.resolve("session-1", location));
    await expect(
      runArchive((storage) => storage.deleteResolved("session-1", location)),
    ).resolves.toBeUndefined();
    await expect(
      runArchive((storage) => storage.deleteResolved("session-1", location)),
    ).rejects.toThrow("Cake could not find resolved session session-1");
    expect(
      await runArchive((storage) => storage.resolved(location).pipe(Stream.runCollect)),
    ).toEqual([]);
  });
});
