import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, type Path, PlatformError, Layer, Stream } from "effect";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveCakePaths } from "../../../../src/config/CakePaths";
import { defaultApplicationState } from "../../../../src/contracts/application/application-data";
import {
  planPiSessionMigration,
  applyPiSessionMigration,
} from "../../../../src/services/pi/PiSessionMigration";
import type { WorktreeStorage } from "../../../../src/services/storage/WorktreeStorage";
import { makeWorktreeStorageLive } from "../../../../src/services/storage/WorktreeStorageLive";
import { SessionArchiveStorage } from "../../../../src/services/storage/SessionArchiveStorage";
import { makeSessionArchiveStorageLive } from "../../../../src/services/storage/SessionArchiveStorageLive";
import {
  findSessionFileById,
  workingDirectorySessionPath,
} from "../../../../src/services/storage/session-files";
import { streamWorkspaceSessions } from "../../../../src/services/pi/runtime/session-discovery";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const roots: string[] = [];
const timestamp = "2026-01-01T00:00:00.000Z";
async function fixture(applicationVersion = 5) {
  const root = await mkdtemp(join(tmpdir(), "cake-pi-session-migration-"));
  roots.push(root);
  const agent = join(root, "shared-agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agent);
  vi.stubEnv("PI_CODING_AGENT_SESSION_DIR", "");
  const paths = resolveCakePaths({
    env: { CAKE_HOME: join(root, "cake") },
    piAgentDirectory: agent,
  });
  const project = join(root, "project");
  await mkdir(project);
  await mkdir(paths.state, { recursive: true });
  await writeFile(
    join(paths.state, "application.json"),
    JSON.stringify({
      version: applicationVersion,
      data: {
        ...defaultApplicationState(),
        projects: [{ path: project, name: "project", addedAt: timestamp, lastOpenedAt: timestamp }],
      },
    }),
  );
  const layer = Layer.mergeAll(
    makeWorktreeStorageLive(paths.worktrees),
    makeSessionArchiveStorageLive(paths.resolvedProjectMetadata, {
      activeRoot: paths.piSessions,
      resolvedRoot: paths.piResolvedSessions,
    }),
  ).pipe(Layer.provide(platform));
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | WorktreeStorage | SessionArchiveStorage
    >,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.provide(platform)));
  const sourceRoot = join(paths.home, "pi", "sessions");
  const legacyArchive = join(paths.home, "pi", "resolved-sessions");
  const sourceDirectory = workingDirectorySessionPath(project, sourceRoot);
  const writeSession = async (id: string, archived = false, parentSession?: string) => {
    const directory = workingDirectorySessionPath(project, archived ? legacyArchive : sourceRoot);
    await mkdir(directory, { recursive: true });
    const file = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    const entries = [
      {
        type: "session",
        version: 3,
        id,
        timestamp,
        cwd: project,
        ...(parentSession ? { parentSession } : {}),
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp,
        message: { role: "user", content: "Original request", timestamp: 0 },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Original response" }],
          api: "openai-completions",
          provider: "fixture",
          model: "fixture",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      },
      {
        type: "compaction",
        id: "compaction-1",
        parentId: "assistant-1",
        timestamp,
        summary: "Earlier context",
        firstKeptEntryId: "user-1",
        tokensBefore: 100,
      },
    ];
    await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    return file;
  };
  return {
    root,
    paths,
    project,
    sourceRoot,
    sourceDirectory,
    legacyArchive,
    writeSession,
    run,
    plan: () => run(planPiSessionMigration(paths)),
  };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Explicit shared-Pi session migration", () => {
  it.each([5, 6])(
    "reads project routing from metadata version %i without rewriting settings",
    async (version) => {
      const f = await fixture(version);
      await f.writeSession("archived", true);
      const document = join(f.paths.state, "application.json");
      const before = await readFile(document, "utf8");
      const plan = await f.plan();
      expect(plan.items[0]?.metadata?.projectPath).toBe(f.project);
      expect(plan.items[0]?.metadata?.projectName).toBe("project");
      await f.run(applyPiSessionMigration(f.paths, plan));
      expect(await readFile(document, "utf8")).toBe(before);
    },
  );

  it("rejects unknown metadata versions without copying or rewriting them", async () => {
    const f = await fixture(99);
    await f.writeSession("active");
    const document = join(f.paths.state, "application.json");
    const before = await readFile(document, "utf8");
    await expect(f.plan()).rejects.toThrow();
    expect(await readFile(document, "utf8")).toBe(before);
    await expect(stat(f.paths.piSessions)).rejects.toThrow();
  });

  it("plans read-only, excludes Cake sidecar sessions, and does not touch either configuration", async () => {
    const f = await fixture();
    const source = await f.writeSession("active");
    await mkdir(f.paths.piAgent, { recursive: true });
    await writeFile(join(f.paths.piAgent, "settings.json"), '{"quietStartup":true}');
    await writeFile(join(f.paths.piAgent, "auth.json"), '{"fixture":"shared"}');
    await writeFile(join(f.paths.home, "pi", "settings.json"), '{"quietStartup":false}');
    await mkdir(f.paths.piGlobalChatSessions, { recursive: true });
    await writeFile(join(f.paths.piGlobalChatSessions, "sidecar.jsonl"), await readFile(source));
    const before = await readFile(source, "utf8");
    const plan = await f.plan();
    expect(plan.items.map((item) => item.sessionId)).toEqual(["active"]);
    expect(plan.conflicts).toEqual([]);
    expect(await readFile(source, "utf8")).toBe(before);
    expect(await readdir(f.paths.piAgent)).toEqual(["auth.json", "settings.json"]);
    await expect(stat(f.paths.resolvedProjectMetadata)).rejects.toThrow();
    expect(await readFile(join(f.paths.piAgent, "settings.json"), "utf8")).toBe(
      '{"quietStartup":true}',
    );
    expect(await readFile(join(f.paths.home, "pi", "settings.json"), "utf8")).toBe(
      '{"quietStartup":false}',
    );
  });

  it("preserves IDs, byte-for-byte history, compaction, forks and resolution routing; Pi and Cake continue the same files", async () => {
    const f = await fixture();
    const active = await f.writeSession("active");
    const fork = await f.writeSession("fork", false, active);
    const resolved = await f.writeSession("resolved");
    await f.run(
      Effect.flatMap(SessionArchiveStorage, (archive) =>
        archive.resolveProject(
          "resolved",
          { cwd: f.project, activeRoot: f.sourceRoot, resolvedRoot: f.legacyArchive },
          { projectPath: f.project, projectName: "project" },
        ),
      ),
    );
    const archived = await f.writeSession("archived", true);
    const plan = await f.plan();
    expect(await f.run(applyPiSessionMigration(f.paths, plan))).toEqual({
      copied: 4,
      alreadyCopied: 0,
      originalsRetained: true,
    });
    for (const item of plan.items) {
      expect(await readFile(item.destination, "utf8")).toBe(await readFile(item.source, "utf8"));
      expect((await stat(item.destination)).mtimeMs).toBeCloseTo(
        (await stat(item.source)).mtimeMs,
        1,
      );
      const manager = SessionManager.open(item.destination, dirname(item.destination));
      expect(manager.getSessionId()).toBe(item.sessionId);
      expect(manager.getLeafId()).toBe("compaction-1");
    }
    const targetLocation = {
      cwd: f.project,
      activeRoot: f.paths.piSessions,
      resolvedRoot: f.paths.piResolvedSessions,
    };
    await f.run(
      Effect.flatMap(SessionArchiveStorage, (archive) =>
        Effect.gen(function* () {
          const ids = yield* archive.resolvedIds(targetLocation);
          expect([...ids].sort()).toEqual(["archived", "resolved"]);
          const records = yield* Stream.runCollect(archive.resolvedProjects(f.project));
          expect(records.map((entry) => entry.activeRoot)).toEqual([
            f.paths.piSessions,
            f.paths.piSessions,
          ]);
          expect(
            (yield* archive.resolvedIds({ ...targetLocation, activeRoot: f.sourceRoot })).size,
          ).toBe(0);
          const activeSessions = yield* Stream.runCollect(
            streamWorkspaceSessions(f.project, f.paths.piSessions, {
              excludedSessionIds: [...ids],
            }),
          );
          expect(activeSessions.map((session) => session.id).sort()).toEqual(["active", "fork"]);
          yield* archive.restoreProject("resolved");
          expect(yield* archive.locate("resolved", targetLocation)).toBe("active");
        }),
      ),
    );
    const activeTarget = (await findSessionFileById("active", {
      workingDirectory: f.project,
      root: f.paths.piSessions,
    }))!;
    const terminalPi = SessionManager.open(activeTarget, dirname(activeTarget));
    terminalPi.appendSessionInfo("Terminal continuation");
    const cakeManager = SessionManager.open(
      (await findSessionFileById("active", {
        workingDirectory: f.project,
        root: f.paths.piSessions,
      }))!,
      dirname(activeTarget),
    );
    expect(cakeManager.getSessionName()).toBe("Terminal continuation");
    cakeManager.appendCustomEntry("cake-reference", { sessionId: "active" });
    expect(SessionManager.open(activeTarget, dirname(activeTarget)).getEntries().at(-1)?.type).toBe(
      "custom",
    );
    const forkTarget = plan.items.find((item) => item.source === fork)!.destination;
    expect(SessionManager.open(forkTarget, dirname(forkTarget)).getHeader()?.parentSession).toBe(
      active,
    );
    // Backups keep Pi's original parent-session references valid.
    for (const original of [active, fork, resolved, archived])
      expect((await stat(original)).isFile()).toBe(true);
    const repeated = await f.plan();
    expect(repeated.conflicts).toEqual([]);
    expect(await f.run(applyPiSessionMigration(f.paths, repeated))).toEqual({
      copied: 0,
      alreadyCopied: 4,
      originalsRetained: true,
    });
  });

  it("rejects destination collisions even when timestamps differ, without overwriting or applying other entries", async () => {
    const f = await fixture();
    const source = await f.writeSession("collision");
    await f.writeSession("otherwise-safe");
    const destinationDirectory = workingDirectorySessionPath(f.project, f.paths.piSessions);
    await mkdir(destinationDirectory, { recursive: true });
    const other = join(destinationDirectory, "2030-01-01T00-00-00-000Z_collision.jsonl");
    await writeFile(other, await readFile(source));
    const original = await readFile(other, "utf8");
    const plan = await f.plan();
    expect(plan.conflicts.some((conflict) => conflict.includes("already has session ID"))).toBe(
      true,
    );
    await expect(f.run(applyPiSessionMigration(f.paths, plan))).rejects.toThrow(
      "already has session ID",
    );
    expect(await readFile(other, "utf8")).toBe(original);
    expect(await readdir(destinationDirectory)).toEqual([
      "2030-01-01T00-00-00-000Z_collision.jsonl",
    ]);
  });

  it("rolls back its exclusive copy and metadata rebind when the receipt cannot commit", async () => {
    const f = await fixture();
    const source = await f.writeSession("resolved");
    await f.run(
      Effect.flatMap(SessionArchiveStorage, (archive) =>
        archive.resolveProject(
          "resolved",
          { cwd: f.project, activeRoot: f.sourceRoot, resolvedRoot: f.legacyArchive },
          { projectPath: f.project, projectName: "project" },
        ),
      ),
    );
    const plan = await f.plan();
    const indexFile = join(f.paths.resolvedProjectMetadata, "resolution.json");
    const before = await readFile(indexFile, "utf8");
    const fs = await f.run(
      Effect.gen(function* () {
        return yield* FileSystem.FileSystem;
      }),
    );
    const controlled = FileSystem.makeNoop({
      ...fs,
      rename: (from, to) =>
        to.endsWith("pi-session-migration.json")
          ? Effect.fail(
              PlatformError.systemError({
                _tag: "Unknown",
                module: "MigrationTest",
                method: "rename",
              }),
            )
          : fs.rename(from, to),
    });
    await expect(
      f.run(
        applyPiSessionMigration(f.paths, plan).pipe(
          Effect.provide(Layer.succeed(FileSystem.FileSystem)(controlled)),
        ),
      ),
    ).rejects.toThrow();
    await expect(stat(plan.items[0]!.destination)).rejects.toThrow();
    expect(await readFile(indexFile, "utf8")).toBe(before);
    expect((await stat(source)).isFile()).toBe(true);
    const entry = await f.run(
      Effect.flatMap(SessionArchiveStorage, (archive) => archive.resolvedProjectEntry("resolved")),
    );
    expect(entry?.activeRoot).toBe(f.sourceRoot);
    expect((await f.plan()).items[0]?.completed).toBe(false);
  });

  it("rejects a stale plan if a source session changed after inspection", async () => {
    const f = await fixture();
    const source = await f.writeSession("active");
    const plan = await f.plan();
    SessionManager.open(source, dirname(source)).appendSessionInfo("Still running");
    await expect(f.run(applyPiSessionMigration(f.paths, plan))).rejects.toThrow("plan changed");
    await expect(stat(f.paths.piSessions)).rejects.toThrow();
  });
});
