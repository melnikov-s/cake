import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cakeWorkspaceSessionDirectory,
  listWorkspaceSessions,
} from "../../../src/services/pi/runtime/session-discovery";
import { SessionArchiveRepository } from "../../../src/main/session-archive-repository";

const directories: string[] = [];

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
    join(activeDirectory, "session.jsonl"),
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

describe("SessionArchiveRepository", () => {
  it("moves a project session out of Pi's active root and restores it", async () => {
    const location = await fixture();
    const repository = new SessionArchiveRepository();

    await expect(repository.resolve("session-1", location)).resolves.toBe(true);
    await expect(repository.resolve("session-1", location)).resolves.toBe(false);
    expect(await listWorkspaceSessions(location.cwd, location.activeRoot)).toEqual([]);
    expect(
      await listWorkspaceSessions(location.cwd, location.activeRoot, {
        resolvedSessionDir: location.resolvedRoot,
      }),
    ).toEqual([expect.objectContaining({ id: "session-1", resolved: true })]);

    await expect(repository.restore("session-1", location)).resolves.toBe(true);
    await expect(repository.restore("session-1", location)).resolves.toBe(false);
    expect(await listWorkspaceSessions(location.cwd, location.activeRoot)).toEqual([
      expect.objectContaining({ id: "session-1", resolved: false }),
    ]);
  });

  it("permanently deletes a transcript from either namespace", async () => {
    const activeLocation = await fixture();
    const resolvedLocation = await fixture();
    const repository = new SessionArchiveRepository();
    await repository.resolve("session-1", resolvedLocation);

    await expect(repository.delete("session-1", activeLocation)).resolves.toBeUndefined();
    await expect(repository.delete("session-1", resolvedLocation)).resolves.toBeUndefined();
    await expect(repository.delete("session-1", activeLocation)).rejects.toThrow(
      "Cake could not find session session-1",
    );
  });

  it("permanently deletes only a resolved transcript", async () => {
    const location = await fixture();
    const repository = new SessionArchiveRepository();

    await expect(repository.deleteResolved("session-1", location)).rejects.toThrow(
      "Cake could not find resolved session session-1",
    );
    await repository.resolve("session-1", location);
    await expect(repository.deleteResolved("session-1", location)).resolves.toBeUndefined();
    await expect(repository.deleteResolved("session-1", location)).rejects.toThrow(
      "Cake could not find resolved session session-1",
    );
    expect(
      await listWorkspaceSessions(location.cwd, location.activeRoot, {
        resolvedSessionDir: location.resolvedRoot,
      }),
    ).toEqual([]);
  });
});
