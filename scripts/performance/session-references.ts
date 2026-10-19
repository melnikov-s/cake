import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Effect, Layer, Stream } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { defaultApplicationState } from "../../src/contracts/application/application-data";
import * as references from "../../src/domain/project-sessions/sessionReferences";
import { CakeSessionRuntimes, PiSessionError } from "../../src/services/pi/CakeSessionRuntimes";
import {
  cakeWorkspaceSessionDirectory,
  streamWorkspaceSessionIds,
  streamWorkspaceSessions,
} from "../../src/services/pi/runtime/session-discovery";
import { ProjectSessionConfiguration } from "../../src/services/project-sessions/ProjectSessionConfiguration";
import { ApplicationState } from "../../src/services/storage/ApplicationState";
import { SavedDraftStorage } from "../../src/services/storage/SavedDraftStorage";
import { SessionArchiveStorage } from "../../src/services/storage/SessionArchiveStorage";
import { SessionFamilyStorage } from "../../src/services/storage/SessionFamilyStorage";
import { ManagedWorktrees } from "../../src/services/worktrees/ManagedWorktrees";

const sessionCount = 24;
const historyEntries = Number(process.argv[2] ?? 32);
if (![0, 32, 128].includes(historyEntries)) throw new Error("Expected history size 0, 32 or 128");
const directory = await mkdtemp(join(tmpdir(), "cake-reference-perf-"));
const sessionRoot = join(directory, "sessions");
const ids: string[] = [];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let transcriptOpens = 0;
const open = SessionManager.open;
SessionManager.open = (...args) => {
  transcriptOpens++;
  return open(...args);
};
try {
  for (let index = 0; index < sessionCount; index++) {
    const manager = SessionManager.create(
      directory,
      cakeWorkspaceSessionDirectory(directory, sessionRoot),
      { id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}` },
    );
    ids.push(manager.getSessionId());
    manager.appendMessage({ role: "user", content: "Deterministic fixture", timestamp: 1 });
    for (let entry = 0; entry <= historyEntries; entry++)
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: entry ? "x".repeat(8_192) : "Fixture ready" }],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage,
        stopReason: "stop",
        timestamp: entry + 2,
      });
  }
  const state = {
    ...defaultApplicationState(),
    projects: [
      {
        path: directory,
        name: "Fixture",
        addedAt: "2026-01-01T00:00:00.000Z",
        lastOpenedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
  const layer = Layer.mergeAll(
    Layer.mock(ApplicationState, { snapshot: () => state }),
    Layer.succeed(ProjectSessionConfiguration, {
      agentDirectory: join(directory, "agent"),
      sessionDirectory: sessionRoot,
      resolvedSessionDirectory: join(directory, "resolved"),
    }),
    Layer.mock(ManagedWorktrees, { records: () => Effect.succeed([]) }),
    Layer.mock(SessionFamilyStorage, {
      list: () => Effect.succeed([]),
      state: () => Effect.succeed({ families: [], turns: [], spawnedSessions: [] }),
    }),
    Layer.mock(SavedDraftStorage, { list: () => Effect.succeed([]) }),
    Layer.mock(SessionArchiveStorage, {
      resolvedProjects: () => Stream.empty,
      resolved: () => Stream.empty,
    }),
    Layer.mock(CakeSessionRuntimes, {
      catalog: (query) =>
        streamWorkspaceSessions(query.workingDirectory, query.sessionDirectory).pipe(
          Stream.mapError(
            (cause) => new PiSessionError({ operation: "catalog", message: String(cause) }),
          ),
        ),
      sessionIds: (query) =>
        streamWorkspaceSessionIds(query.workingDirectory, query.sessionDirectory).pipe(
          Stream.mapError(
            (cause) => new PiSessionError({ operation: "sessionIds", message: String(cause) }),
          ),
        ),
    }),
  );
  const resolve = () => references.resolve(ids[0]!).pipe(Effect.provide(layer));
  const project = () => references.project({ sessionId: ids[0]! }).pipe(Effect.provide(layer));
  // Warm imports, schemas and file cache outside the measured interval, equally in both builds.
  await Effect.runPromise(resolve());
  const profilePath = process.argv[3];
  const profiler = profilePath ? new Session() : undefined;
  if (profiler) {
    profiler.connect();
    await profiler.post("Profiler.enable");
    await profiler.post("Profiler.setSamplingInterval", { interval: 1_000 });
    await profiler.post("Profiler.start");
  }
  const results = [];
  for (const concurrency of [1, 4]) {
    transcriptOpens = 0;
    const cpu = process.cpuUsage();
    const start = performance.now();
    for (let round = 0; round < 3; round++)
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          await Effect.runPromise(resolve());
          await Effect.runPromise(project());
        }),
      );
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    results.push({
      concurrency,
      operations: concurrency * 6,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      cpuMs: Math.round((used.user + used.system) / 10) / 100,
      transcriptOpens,
    });
  }
  if (profiler && profilePath) {
    const { profile } = await profiler.post("Profiler.stop");
    profiler.disconnect();
    await writeFile(profilePath, JSON.stringify(profile));
  }
  console.log(JSON.stringify({ sessionCount, historyEntries, results, profilePath }, null, 2));
} finally {
  SessionManager.open = open;
  await rm(directory, { recursive: true, force: true });
}
