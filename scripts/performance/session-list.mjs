/* global console, process */
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Layer, Logger, References, Stream } from "effect";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import { invoke } from "../../src/domain/application/agentControl";
import { CakeSessionRuntimes, PiSessionError } from "../../src/services/pi/CakeSessionRuntimes";
import {
  loadWorkspacePiSessionSummary,
  loadWorkspacePiSessionPreview,
  streamWorkspaceSessionIds,
  streamWorkspaceSessions,
} from "../../src/services/pi/runtime/session-discovery";
import { ProjectSessionConfiguration } from "../../src/services/project-sessions/ProjectSessionConfiguration";
import { ApplicationState } from "../../src/services/storage/ApplicationState";
import { SavedDraftStorage } from "../../src/services/storage/SavedDraftStorage";
import { TaskInputStorage } from "../../src/services/storage/TaskInputStorage";
import { SessionArchiveStorage } from "../../src/services/storage/SessionArchiveStorage";
import { makeSessionArchiveStorageLive } from "../../src/services/storage/SessionArchiveStorageLive";
import { makeSessionFamilyStorageLive } from "../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../src/services/worktrees/ManagedWorktrees";
import { workingDirectorySessionPath } from "../../src/services/storage/session-files";

const historyKiB = Number(process.argv[2]);
if (!Number.isInteger(historyKiB) || historyKiB < 0 || historyKiB > 1024)
  throw new Error("history-kib must be 0..1024");
const root = await mkdtemp(join(tmpdir(), "cake-list-fixture-"));
const agent = join(root, "agent");
// This subprocess owns its environment; all SDK configuration/locks stay in the fixture.
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
const sessionRoot = join(agent, "sessions");
const resolvedRoot = join(root, "resolved");
const metadataRoot = join(root, "metadata");
const familyFile = join(root, "families.json");
const timestamp = "2026-01-01T00:00:00.000Z";
const projects = [0, 1].map((i) => ({
  path: join(root, `project-${i}`),
  name: `Project ${i}`,
  addedAt: timestamp,
  lastOpenedAt: timestamp,
}));
const records = Array.from({ length: 697 }, (_, i) => ({
  worktreePath: join(root, `worktree-${i}`),
  projectPath: projects[i % 2].path,
  branch: `agent/${i}`,
  baseBranch: "main",
  createdAt: timestamp,
}));
const locations = [
  ...projects.map((project) => ({ cwd: project.path, projectPath: project.path })),
  ...records.map((record) => ({ cwd: record.worktreePath, projectPath: record.projectPath })),
];
const families = [];
const resolutions = {};
const digest = (value) => createHash("sha256").update(value).digest("hex");
const counts = {};
const times = {};
const count = (name) => {
  counts[name] = (counts[name] ?? 0) + 1;
};
const timed = (name, effect) =>
  Effect.suspend(() => {
    count(name);
    const start = performance.now();
    return effect.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          times[name] = (times[name] ?? 0) + performance.now() - start;
        }),
      ),
    );
  });
const failure = (operation, cause) => new PiSessionError({ operation, message: String(cause) });
const promise = (operation, run) =>
  timed(operation, Effect.tryPromise({ try: run, catch: (cause) => failure(operation, cause) }));
const stream = (name, value) =>
  Stream.fromEffect(timed(name, value.pipe(Stream.runCollect))).pipe(
    Stream.flatMap(Stream.fromIterable),
  );
const originalOpen = SessionManager.open;
const originalSettings = SettingsManager.create;
try {
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "settings.json"), "{}");
  for (const { cwd } of locations) await mkdir(join(cwd, ".pi"), { recursive: true });
  for (let index = 0; index < 1603; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    // Keep the two query cohorts inside project 0, distributed over its checkouts.
    const location =
      index < 47
        ? locations[index === 0 ? 0 : 2 + (index - 1) * 2]
        : locations[index % locations.length];
    const directory = workingDirectorySessionPath(location.cwd, sessionRoot);
    await mkdir(directory, { recursive: true });
    const file = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    const title = index < 8 ? `parity ${index}` : index < 47 ? `audit ${index}` : `Other ${index}`;
    const entries = [
      { type: "session", version: 3, id, timestamp, cwd: location.cwd },
      {
        type: "message",
        id: "user",
        parentId: null,
        timestamp,
        message: {
          role: "user",
          content: "x".repeat(historyKiB * 1024),
          timestamp: Date.parse(timestamp),
        },
      },
      { type: "session_info", id: "name", parentId: "user", timestamp, name: title },
    ];
    await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    await utimes(file, new Date(timestamp), new Date(Date.parse(timestamp) + index * 1000));
    if (index >= 100 && index < 132) {
      const hash = digest(id);
      const projectDirectory = join(metadataRoot, "projects", digest(location.projectPath));
      const locatorDirectory = join(metadataRoot, "sessions", hash.slice(0, 2));
      await mkdir(projectDirectory, { recursive: true });
      await mkdir(locatorDirectory, { recursive: true });
      await writeFile(
        join(locatorDirectory, `${hash}.json`),
        JSON.stringify({ version: 1, projectPath: location.projectPath }),
      );
      await writeFile(
        join(projectDirectory, `${hash}.json`),
        JSON.stringify({
          version: 2,
          sessionId: id,
          projectPath: location.projectPath,
          projectName: projects.find((project) => project.path === location.projectPath).name,
          workingDirectory: location.cwd,
          activeRoot: sessionRoot,
          resolvedRoot,
          createdAt: timestamp,
          modifiedAt: timestamp,
        }),
      );
      (resolutions[directory] ??= []).push(id);
    }
    if (index >= 47)
      families.push({
        familyId: `family-${index}`,
        parentSessionId: id,
        projectPath: location.projectPath,
        workingDirectory: location.cwd,
        createdAt: timestamp,
        children: [],
      });
  }
  await mkdir(metadataRoot, { recursive: true });
  await writeFile(
    join(metadataRoot, "resolution.json"),
    JSON.stringify({ version: 1, directories: resolutions }),
  );
  await writeFile(
    familyFile,
    JSON.stringify({ version: 8, data: { families, spawnedSessions: [], turns: [] } }),
  );
  SessionManager.open = (...args) => {
    count("transcriptOpens");
    return originalOpen(...args);
  };
  SettingsManager.create = (...args) => {
    count("settingsRouting");
    return originalSettings(...args);
  };
  const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
  const instrumentedFs = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return FileSystem.FileSystem.of({
        ...fs,
        readFileString: (path, ...args) =>
          timed(
            path === familyFile
              ? "familyFileReads"
              : path.endsWith("resolution.json")
                ? "resolutionFileReads"
                : "otherMetadataReads",
            fs.readFileString(path, ...args),
          ),
      });
    }),
  ).pipe(Layer.provide(platform));
  const storagePlatform = Layer.merge(instrumentedFs, NodePath.layer);
  const archive = makeSessionArchiveStorageLive(metadataRoot, {
    activeRoot: sessionRoot,
    resolvedRoot,
  }).pipe(Layer.provide(storagePlatform));
  const measuredArchive = Layer.effect(
    SessionArchiveStorage,
    Effect.gen(function* () {
      const storage = yield* SessionArchiveStorage;
      return SessionArchiveStorage.of({
        ...storage,
        locate: (...args) => timed("routeProbes", storage.locate(...args)),
        resolvedIds: (...args) => timed("resolutionSnapshots", storage.resolvedIds(...args)),
      });
    }),
  ).pipe(Layer.provide(archive));
  const layer = Layer.mergeAll(
    Layer.mock(ApplicationState, {
      snapshot: () => ({ ...defaultApplicationState(), projects }),
      current: () => Effect.succeed({ ...defaultApplicationState(), projects }),
    }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: agent,
      sessionDirectory: sessionRoot,
      resolvedSessionDirectory: resolvedRoot,
    }),
    Layer.mock(ManagedWorktrees, {
      records: () => timed("worktreeReads", Effect.succeed(records)),
    }),
    Layer.mock(SavedDraftStorage, { list: () => timed("draftReads", Effect.succeed([])) }),
    Layer.mock(TaskInputStorage, { isRecipient: () => Effect.succeed(false) }),
    makeSessionFamilyStorageLive(familyFile).pipe(Layer.provide(storagePlatform)),
    measuredArchive,
    Layer.mock(CakeSessionRuntimes, {
      sessionIds: (query) =>
        stream(
          "idDirectories",
          streamWorkspaceSessionIds(query.workingDirectory, query.sessionDirectory),
        ).pipe(Stream.mapError((cause) => failure("ids", cause))),
      catalog: (query) =>
        stream(
          "titleDirectories",
          streamWorkspaceSessions(query.workingDirectory, query.sessionDirectory, query),
        ).pipe(Stream.mapError((cause) => failure("catalog", cause))),
      catalogEntry: (query, id) =>
        promise("titleLookups", () =>
          loadWorkspacePiSessionSummary(query.workingDirectory, id, query.sessionDirectory),
        ),
      inspect: (target, options) =>
        promise("selectedInspections", () =>
          loadWorkspacePiSessionPreview(
            target.workingDirectory,
            target.sessionId,
            target.sessionDirectory,
            false,
            options,
          ),
        ),
      currentStatus: () => Effect.succeed(undefined),
    }),
  );
  const results = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(layer);
        const output = [];
        for (const query of ["parity", "audit"]) {
          for (const key of Object.keys(counts)) delete counts[key];
          for (const key of Object.keys(times)) delete times[key];
          let stages;
          const diagnosticLogger = Logger.make(({ message }) => {
            if (Array.isArray(message) && message[0] === "Session list timings")
              stages = message[1];
          });
          const cpu = process.cpuUsage();
          const start = performance.now();
          const result = yield* invoke(
            "sessions.list",
            { query, limit: 50 },
            {
              kind: "project-session",
              sessionId: "fixture-caller",
              title: "Fixture",
              projectPath: projects[0].path,
            },
          ).pipe(
            Effect.provide(context),
            Effect.provide(Logger.layer([diagnosticLogger])),
            Effect.provideService(References.MinimumLogLevel, "Debug"),
          );
          const elapsedMs = performance.now() - start;
          const used = process.cpuUsage(cpu);
          output.push({
            query,
            elapsedMs: Math.round(elapsedMs),
            cpuMs: Math.round((used.user + used.system) / 1000),
            counts: { ...counts },
            stages,
            serviceMs: Object.fromEntries(
              Object.entries(times).map(([name, value]) => [name, Math.round(value)]),
            ),
            resultDigest: createHash("sha256").update(JSON.stringify(result)).digest("hex"),
            rows: typeof result === "string" ? result.split("\n").length - 2 : result,
          });
        }
        return output;
      }),
    ),
  );
  console.log(
    JSON.stringify({ locations: locations.length, sessions: 1603, historyKiB, results }, null, 2),
  );
  // serviceMs includes nested/concurrent operations: totals are not additive critical-path stages.
} finally {
  SessionManager.open = originalOpen;
  SettingsManager.create = originalSettings;
  await rm(root, { recursive: true, force: true });
}
