/* global console, process */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Effect, FileSystem, Layer, ManagedRuntime, Stream } from "effect";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import * as artifacts from "../../src/domain/artifacts/artifacts";
import { invoke } from "../../src/domain/application/agentControl";
import * as metadata from "../../src/domain/project-sessions/projectSessionMetadata";
import * as references from "../../src/domain/project-sessions/sessionReferences";
import { CakeSessionRuntimes, PiSessionError } from "../../src/services/pi/CakeSessionRuntimes";
import {
  loadWorkspacePiSessionPreview,
  loadWorkspacePiSessionSummary,
  streamWorkspaceSessionIds,
  streamWorkspaceSessions,
} from "../../src/services/pi/runtime/session-discovery";
import { ProjectSessionConfiguration } from "../../src/services/project-sessions/ProjectSessionConfiguration";
import { SessionCatalogChanges } from "../../src/services/session-catalogs/SessionCatalogChanges";
import { ApplicationState } from "../../src/services/storage/ApplicationState";
import { makeArtifactStorageLive } from "../../src/services/storage/ArtifactStorageLive";
import { SavedDraftStorage } from "../../src/services/storage/SavedDraftStorage";
import { SessionArchiveStorage } from "../../src/services/storage/SessionArchiveStorage";
import { makeSessionArchiveStorageLive } from "../../src/services/storage/SessionArchiveStorageLive";
import { makeSessionFamilyStorageLive } from "../../src/services/storage/SessionFamilyStorage";
import { workingDirectorySessionPath } from "../../src/services/storage/session-files";
import { ManagedWorktrees } from "../../src/services/worktrees/ManagedWorktrees";
import { ProjectAccess } from "../../src/services/projects/ProjectAccess";

const root = await mkdtemp(join(tmpdir(), "cake-amplification-fixture-"));
const agent = join(root, "agent");
// This child process owns its environment, including SDK settings/lock paths.
process.env.PI_CODING_AGENT_DIR = agent;
delete process.env.PI_CODING_AGENT_SESSION_DIR;
const timestamp = "2026-01-01T00:00:00.000Z";
const counts = {};
const count = (key, amount = 1) => (counts[key] = (counts[key] ?? 0) + amount);
const measured = (key, effect) => Effect.sync(() => count(key)).pipe(Effect.andThen(effect));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const failure = (operation, cause) => new PiSessionError({ operation, message: String(cause) });
const promise = (operation, run) =>
  Effect.tryPromise({ try: run, catch: (cause) => failure(operation, cause) });
const originalOpen = SessionManager.open;
const originalSettings = SettingsManager.create;
const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);
const filesystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return FileSystem.FileSystem.of({
      ...fs,
      readFileString: (path, ...args) =>
        fs.readFileString(path, ...args).pipe(
          Effect.tap((text) =>
            Effect.sync(() => {
              const kind = path.endsWith("catalog.json")
                ? "catalog"
                : path.endsWith("families.json")
                  ? "family"
                  : "metadata";
              count(`${kind}Reads`);
              count(`${kind}Bytes`, Buffer.byteLength(text));
            }),
          ),
        ),
    });
  }),
).pipe(Layer.provide(platform));
const storagePlatform = Layer.merge(filesystem, NodePath.layer);

async function measure(runtime, name, effect, verify) {
  // First sample includes lazy schema work; two following samples use warm OS caches.
  for (let sample = 0; sample < 3; sample++) {
    for (const key of Object.keys(counts)) delete counts[key];
    const cpu = process.cpuUsage();
    const start = performance.now();
    const result = await runtime.runPromise(effect);
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    verify(result);
    console.log(
      JSON.stringify({
        name,
        sample,
        elapsedMs: Math.round(elapsedMs),
        cpuMs: Math.round((used.user + used.system) / 1000),
        counts: { ...counts },
      }),
    );
  }
}

async function artifactCases() {
  const directory = join(root, "artifacts");
  await mkdir(join(directory, "blobs"), { recursive: true });
  // 1,000 lineages x 10 revisions, 20 selected links: modest blobs, substantial metadata.
  // Write a current-version fixture directly so setup is not quadratic publication work.
  const lineages = [];
  for (let i = 0; i < 1000; i++) {
    const id = `fixture-${i}`;
    const revisions = [];
    for (let revision = 1; revision <= 10; revision++) {
      const snapshot = {
        protocol: "cake.artifact/v1",
        id,
        sessionId: "fixture-session",
        revision,
        kind: "markdown",
        title: id,
        payload: { markdown: "fixture" },
        fallback: { markdown: "fixture" },
        interaction: { mode: "present" },
      };
      const serialized = JSON.stringify(snapshot);
      const digest = hash(serialized);
      revisions.push({
        revision,
        digest,
        kind: "markdown",
        title: id,
        publishedAt: timestamp,
        publishedBySessionId: "fixture-session",
        workingDirectory: root,
      });
      if (i < 20 && revision === 10)
        await writeFile(join(directory, "blobs", `${digest}.json`), serialized);
    }
    lineages.push({ id, createdAt: timestamp, latestRevision: 10, revisions });
  }
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      makeArtifactStorageLive(directory).pipe(Layer.provide(storagePlatform)),
      makeSessionFamilyStorageLive(join(root, "families.json")).pipe(
        Layer.provide(storagePlatform),
      ),
      Layer.mock(ProjectAccess, {
        resolveSessionWorkingDirectory: () => Effect.succeed(root),
        isAllowed: () => Effect.succeed(true),
      }),
    ),
  );
  try {
    for (const selected of [1, 20]) {
      const links = lineages.slice(0, selected).map((lineage) => ({
        lineageId: lineage.id,
        target: { type: "session", sessionId: "fixture-session" },
        selection: { mode: "follow-latest" },
        createdAt: timestamp,
      }));
      await writeFile(
        join(directory, "catalog.json"),
        JSON.stringify({
          version: 4,
          data: { lineages, links, states: [] },
        }),
      );
      await measure(
        runtime,
        `effective-artifacts-${selected}-of-1000x10`,
        artifacts.listEffective("fixture-session"),
        (result) => {
          assert.equal(result.length, selected);
          assert.equal(result[0].latestRevision, 10);
        },
      );
    }
  } finally {
    await runtime.dispose();
  }
}

async function sessionCases() {
  const sessionRoot = join(agent, "sessions");
  const metadataRoot = join(root, "session-metadata");
  const familyFile = join(root, "families.json");
  const projects = [
    { path: join(root, "project"), name: "Fixture", addedAt: timestamp, lastOpenedAt: timestamp },
  ];
  const records = Array.from({ length: 698 }, (_, i) => ({
    projectPath: projects[0].path,
    worktreePath: join(root, `worktree-${i}`),
    branch: `agent/${i}`,
    baseBranch: "main",
    createdAt: timestamp,
  }));
  const locations = [projects[0].path, ...records.map((record) => record.worktreePath)];
  for (const cwd of locations) {
    await mkdir(join(cwd, ".pi"), { recursive: true });
    await mkdir(workingDirectorySessionPath(cwd, sessionRoot), { recursive: true });
  }
  const ids = [];
  const families = [];
  // Both fixture sizes hold 100 MiB of history; large increases metadata pressure.
  const sessionCount = process.argv[2] === "large" ? 1600 : 200;
  const historyKiB = process.argv[2] === "large" ? 64 : 512;
  for (let i = 0; i < sessionCount; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    ids.push(id);
    const cwd = locations[i % locations.length];
    const entries = [
      { type: "session", version: 3, id, cwd, timestamp },
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
      { type: "session_info", id: "title", parentId: "user", timestamp, name: `Fixture ${i}` },
    ];
    await writeFile(
      join(workingDirectorySessionPath(cwd, sessionRoot), `2026-01-01T00-00-00-000Z_${id}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
    if (i % 2 === 0)
      families.push({
        familyId: `family-${i}`,
        parentSessionId: id,
        projectPath: projects[0].path,
        workingDirectory: cwd,
        createdAt: timestamp,
        children: [
          {
            sessionId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`,
            parentSessionId: id,
            requestId: `request-${i}`,
            workingDirectory: locations[(i + 1) % locations.length],
            createdAt: timestamp,
          },
        ],
      });
  }
  const writeFamilies = (items) =>
    writeFile(
      familyFile,
      JSON.stringify({
        version: 8,
        data: { families: items, turns: [], spawnedSessions: [] },
      }),
    );
  await writeFamilies([]);
  const archive = makeSessionArchiveStorageLive(metadataRoot, {
    activeRoot: sessionRoot,
    resolvedRoot: join(root, "resolved"),
  }).pipe(Layer.provide(storagePlatform));
  const measuredArchive = Layer.effect(
    SessionArchiveStorage,
    Effect.gen(function* () {
      const storage = yield* SessionArchiveStorage;
      return SessionArchiveStorage.of({
        ...storage,
        locate: (...args) => measured("routeProbes", storage.locate(...args)),
      });
    }),
  ).pipe(Layer.provide(archive));
  const state = { ...defaultApplicationState(), projects };
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      measuredArchive,
      makeSessionFamilyStorageLive(familyFile).pipe(Layer.provide(storagePlatform)),
      Layer.succeed(ProjectSessionConfiguration, {
        agentDirectory: agent,
        sessionDirectory: sessionRoot,
        resolvedSessionDirectory: join(root, "resolved"),
      }),
      Layer.mock(ApplicationState, { snapshot: () => state, current: () => Effect.succeed(state) }),
      Layer.mock(ManagedWorktrees, {
        records: () => measured("worktreeReads", Effect.succeed(records)),
      }),
      Layer.mock(SavedDraftStorage, { list: () => Effect.succeed([]) }),
      Layer.mock(SessionCatalogChanges, { initialThenChanges: (initial) => initial }),
      Layer.mock(CakeSessionRuntimes, {
        sessionIds: (query) =>
          Stream.fromEffect(measured("idDirectories", Effect.void)).pipe(
            Stream.flatMap(() =>
              streamWorkspaceSessionIds(query.workingDirectory, query.sessionDirectory),
            ),
            Stream.mapError((cause) => failure("ids", cause)),
          ),
        catalog: (query) =>
          streamWorkspaceSessions(query.workingDirectory, query.sessionDirectory, query).pipe(
            Stream.mapError((cause) => failure("catalog", cause)),
          ),
        catalogEntry: (query, id) =>
          promise("catalogEntry", () =>
            loadWorkspacePiSessionSummary(query.workingDirectory, id, query.sessionDirectory),
          ),
        inspect: (target, options) =>
          promise("inspect", () =>
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
    ),
  );
  const caller = {
    kind: "project-session",
    sessionId: "fixture-caller",
    title: "Fixture",
    projectPath: projects[0].path,
  };
  try {
    await measure(
      runtime,
      "resolve-canonical-uuid-699-locations",
      references.resolve(ids[0]),
      (result) => assert.equal(result, ids[0]),
    );
    await measure(
      runtime,
      "sessions-info-standalone-699-locations",
      Effect.scoped(invoke("sessions.info", { sessionId: ids[0] }, caller)),
      (result) => assert.equal(result.session.sessionId, ids[0]),
    );
    const sidebar = metadata
      .observeCatalog({ projectPath: projects[0].path, resolved: false })
      .pipe(
        Effect.flatMap((stream) => Stream.runCollect(stream)),
        Effect.scoped,
      );
    const verifySidebar = (result) => assert.equal(result[0].sessions.length, sessionCount);
    await measure(runtime, `sidebar-${sessionCount}-standalone-100MiB`, sidebar, verifySidebar);
    await writeFamilies(families);
    await measure(runtime, `sidebar-${families.length}-families-100MiB`, sidebar, verifySidebar);
    // SidebarSessionListStore mounts BOTH queries, even with a collapsed resolved lane.
    const resolvedSidebar = metadata
      .observeCatalog({ projectPath: projects[0].path, resolved: true })
      .pipe(
        Effect.flatMap((stream) => Stream.runCollect(stream)),
        Effect.scoped,
      );
    await measure(
      runtime,
      `resolved-sidebar-${families.length}-active-families-zero-results`,
      resolvedSidebar,
      (result) => assert.equal(result[0].sessions.length, 0),
    );
  } finally {
    await runtime.dispose();
  }
}

try {
  await mkdir(agent, { recursive: true });
  await writeFile(join(agent, "settings.json"), "{}");
  SessionManager.open = (...args) => {
    count("transcriptOpens");
    count("transcriptBytes", statSync(args[0]).size);
    return originalOpen(...args);
  };
  SettingsManager.create = (...args) => {
    count("settingsCreates");
    return originalSettings(...args);
  };
  if (!["sessions", "large"].includes(process.argv[2])) await artifactCases();
  if (process.argv[2] !== "artifacts") await sessionCases();
} finally {
  SessionManager.open = originalOpen;
  SettingsManager.create = originalSettings;
  await rm(root, { recursive: true, force: true });
}
