import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Effect, FileSystem, Layer, Path, Stream } from "effect";
import { expect } from "vitest";
import { defaultApplicationState } from "../../../src/contracts/application/application-data";
import { resolveSessionReference } from "../../../src/contracts/project-sessions/session-reference";
import { observeConversation } from "../../../src/domain/project-sessions/projectSessionOperations";
import { lookup, open } from "../../../src/domain/project-sessions/projectSessionMetadata";
import { makeCakeSessionRuntimesLayer } from "../../../src/services/pi/CakeSessionRuntimes";
import { ProjectSessionConfiguration } from "../../../src/services/project-sessions/ProjectSessionConfiguration";
import { ApplicationState } from "../../../src/services/storage/ApplicationState";
import {
  SessionFamilyStorage,
  type SessionFamily,
} from "../../../src/services/storage/SessionFamilyStorage";
import { makeSessionArchiveStorageLive } from "../../../src/services/storage/SessionArchiveStorageLive";
import { ManagedWorktrees } from "../../../src/services/worktrees/ManagedWorktrees";
import {
  streamSessionFileIds,
  workingDirectorySessionPath,
} from "../../../src/services/storage/session-files";
import {
  loadWorkspacePiSessionPreview,
  loadWorkspacePiSessionSummary,
} from "../../../src/services/pi/runtime/session-discovery";
import { SessionCatalogChanges } from "../../../src/services/session-catalogs/SessionCatalogChanges";
import { WorkflowTestLive } from "../helpers/workflowFixture";
import {
  fakeRuntime,
  makeRuntimeRecoveryStorageTestLayer,
  snapshot,
} from "../helpers/piRuntimeFixture";
import { makeHeadlessProjectSessionRuntimeMechanismTestLayer } from "./projectSessionRuntimeTestLayer";

const parent = "01957936-0000-7000-8000-000012345678";
const child = "01957936-0000-7000-8000-000087654321";
// Outside this family, but sharing the parent's short suffix: a family-only short ref is unsafe.
const collision = "01957936-0000-7000-8000-000112345678";
const timestamp = "2026-01-01T00:00:00.000Z";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const PlatformLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const fixture = Effect.fn("ChildColdOpen.fixture")(function* (archivedCount: number) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cake-child-cold-open-" });
  const projectPath = path.join(root, "project");
  const activeRoot = path.join(root, "sessions");
  const resolvedRoot = path.join(root, "resolved");
  const metadataRoot = path.join(root, "metadata");
  const workingDirectory = path.join(root, "child-worktree");
  const records = Array.from({ length: 100 }, (_, index) => ({
    worktreePath: index === 0 ? workingDirectory : path.join(root, `worktree-${index}`),
    projectPath,
    branch: `agent/worker-${index}`,
    baseBranch: "main",
    createdAt: timestamp,
    state: "active" as const,
  }));
  // Real Pi filenames and transcripts, including unrelated sessions in each directory.
  for (const cwd of [projectPath, ...records.map((record) => record.worktreePath)]) {
    const directory = workingDirectorySessionPath(cwd, activeRoot);
    yield* fs.makeDirectory(directory, { recursive: true });
    const targetId =
      cwd === projectPath
        ? parent
        : cwd === workingDirectory
          ? child
          : cwd === records[1]?.worktreePath
            ? collision
            : randomUUID();
    yield* fs.writeFileString(
      path.join(directory, `2026-01-01T00-00-00-000Z_${targetId}.jsonl`),
      [
        { type: "session", version: 3, id: targetId, timestamp, cwd },
        {
          type: "message",
          id: "user-1",
          parentId: null,
          timestamp,
          message: { role: "user", content: `History for ${targetId}`, timestamp: 1767225600000 },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    for (let index = 0; index < 10; index++) {
      const id = randomUUID();
      yield* fs.writeFileString(
        path.join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
        JSON.stringify({ type: "session", version: 3, id, timestamp, cwd }) + "\n",
      );
    }
  }
  // Persisted v2 archive metadata and locators; use real storage reads, not a synthetic delay.
  const projectMetadata = path.join(metadataRoot, "projects", digest(projectPath));
  yield* fs.makeDirectory(projectMetadata, { recursive: true });
  const archivedIds = Array.from(
    { length: archivedCount },
    (_, index) => `01957936-0000-7000-8001-${index.toString(16).padStart(12, "0")}`,
  );
  for (const sessionId of archivedIds) {
    yield* fs.writeFileString(
      path.join(
        workingDirectorySessionPath(projectPath, activeRoot),
        `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`,
      ),
      JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectPath }) +
        "\n",
    );
    const hash = digest(sessionId);
    const locatorDirectory = path.join(metadataRoot, "sessions", hash.slice(0, 2));
    yield* fs.makeDirectory(locatorDirectory, { recursive: true });
    yield* fs.writeFileString(
      path.join(locatorDirectory, `${hash}.json`),
      JSON.stringify({ version: 1, projectPath }),
    );
    yield* fs.writeFileString(
      path.join(projectMetadata, `${hash}.json`),
      JSON.stringify({
        version: 2,
        sessionId,
        projectPath,
        projectName: "Project",
        workingDirectory: projectPath,
        activeRoot,
        resolvedRoot,
        createdAt: timestamp,
        modifiedAt: timestamp,
      }),
    );
  }
  yield* fs.writeFileString(
    path.join(metadataRoot, "resolution.json"),
    JSON.stringify({
      version: 1,
      directories: { [workingDirectorySessionPath(projectPath, activeRoot)]: archivedIds },
    }),
  );
  const family: SessionFamily = {
    familyId: "cold-open-family",
    parentSessionId: parent,
    projectPath,
    workingDirectory: projectPath,
    createdAt: timestamp,
    children: [
      {
        sessionId: child,
        parentSessionId: parent,
        workingDirectory,
        requestId: "cold-open-child",
        createdAt: timestamp,
      },
    ],
  };
  return { projectPath, activeRoot, resolvedRoot, metadataRoot, workingDirectory, records, family };
});

it.effect.each([0, 1000, 5000])(
  "opens a cold child with %i archived sessions without global discovery",
  (archivedCount) =>
    Effect.gen(function* () {
      const f = yield* fixture(archivedCount);
      const state = {
        ...defaultApplicationState(),
        projects: [
          { path: f.projectPath, name: "Project", addedAt: timestamp, lastOpenedAt: timestamp },
        ],
      };
      const reads: string[] = [];
      const scans: string[] = [];
      const prompts: string[] = [];
      let runtimeStartMs = 0;
      let hydrationMs = 0;
      const measuredFs = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          return {
            ...fs,
            readFileString: (file: string, encoding?: string) => {
              reads.push(file);
              return fs.readFileString(file, encoding);
            },
          };
        }),
      ).pipe(Layer.provide(NodeFileSystem.layer));
      const dependencies = Layer.mergeAll(
        WorkflowTestLive,
        makeHeadlessProjectSessionRuntimeMechanismTestLayer(),
        SessionCatalogChanges.layer,
        Layer.succeed(ProjectSessionConfiguration, {
          agentDirectory: "/unused-agent",
          sessionDirectory: f.activeRoot,
          resolvedSessionDirectory: f.resolvedRoot,
        }),
        makeSessionArchiveStorageLive(f.metadataRoot, {
          activeRoot: f.activeRoot,
          resolvedRoot: f.resolvedRoot,
        }).pipe(Layer.provide(Layer.mergeAll(measuredFs, NodePath.layer))),
        Layer.mock(ApplicationState, {
          snapshot: () => state,
          current: () => Effect.succeed(state),
        }),
        Layer.mock(SessionFamilyStorage, {
          familyForMember: () => Effect.succeed(f.family),
          list: () => Effect.succeed([f.family]),
          state: () => Effect.succeed({ families: [f.family], turns: [], spawnedSessions: [] }),
          settleTurn: () => Effect.void,
        }),
        Layer.mock(ManagedWorktrees, {
          records: () => Effect.succeed(f.records),
          awaitSetup: () => Effect.void,
        }),
        makeCakeSessionRuntimesLayer({
          createRuntime: (options) =>
            Effect.gen(function* () {
              runtimeStartMs = performance.now();
              prompts.push(options.additionalSystemPrompt ?? "");
              const hydrationStart = performance.now();
              // Replace only engine startup. Hydrate the disposable transcript through
              // the real Pi adapter; providers, resource loading and Electron are excluded.
              const preview = yield* Effect.promise(() =>
                loadWorkspacePiSessionPreview(
                  options.cwd,
                  options.sessionId ?? "",
                  options.sessionDir,
                ),
              );
              hydrationMs = performance.now() - hydrationStart;
              if (!preview) return yield* Effect.die("Missing fixture transcript");
              return {
                ...fakeRuntime(options, () => undefined),
                sessionId: preview.sessionId,
                sessionFile: preview.sessionFile,
                snapshot: async () => ({
                  ...snapshot,
                  workspacePath: options.cwd,
                  sessionId: preview.sessionId,
                  sessionFile: preview.sessionFile,
                  parts: preview.parts,
                }),
              };
            }),
          sessionIds: (query) => {
            scans.push(query.workingDirectory);
            return streamSessionFileIds({
              workingDirectory: query.workingDirectory,
              root: query.sessionDirectory,
            });
          },
          catalog: () => Stream.empty,
          catalogEntry: (query, sessionId) =>
            Effect.promise(() =>
              loadWorkspacePiSessionSummary(
                query.workingDirectory,
                sessionId,
                query.sessionDirectory,
              ),
            ),
          inspect: (target) =>
            Effect.promise(() =>
              loadWorkspacePiSessionPreview(
                target.workingDirectory,
                target.sessionId,
                target.sessionDirectory,
              ),
            ),
          changelog: () => Effect.succeed(""),
        }).pipe(Layer.provide(makeRuntimeRecoveryStorageTestLayer())),
      );
      yield* Effect.gen(function* () {
        for (const sessionId of [parent, child]) {
          reads.length = 0;
          scans.length = 0;
          const start = performance.now();
          // Match the backend calls awaited by ProjectWorkbenchStore before presentation.
          const entry = yield* lookup({ sessionId });
          const lookupMs = performance.now() - start;
          expect(entry.sessionId).toBe(sessionId);
          const target = { sessionId, workingDirectory: entry.workingDirectory };
          yield* open(target);
          const validatedMs = performance.now() - start;
          const stream = yield* observeConversation(target);
          let previewMs = 0;
          const updates = yield* stream.pipe(
            Stream.tap((update) =>
              Effect.sync(() => {
                if (update._tag === "Preview") previewMs = performance.now() - start;
              }),
            ),
            Stream.take(2),
            Stream.runCollect,
          );
          const first = updates[0];
          const totalMs = performance.now() - start;
          // Reproduce timings with --reporter=default --silent=false. Fixture creation
          // and layer acquisition are outside these lookup-to-preview/live intervals.
          console.log(
            JSON.stringify({
              sessionId: sessionId === parent ? "parent" : "child",
              archivedCount,
              totalMs,
              previewMs,
              lookupMs,
              validationMs: validatedMs - lookupMs,
              beforeRuntimeMs: runtimeStartMs - start,
              hydrationMs,
              metadataReads: reads.length,
              directoryScans: scans.length,
            }),
          );
          expect(updates.map((update) => update._tag)).toEqual(["Preview", "Snapshot"]);
          if (first?._tag === "Preview") {
            expect(first.snapshot.sessionId).toBe(sessionId);
            expect(first.snapshot.parts).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ role: "user", text: `History for ${sessionId}` }),
              ]),
            );
          }
          // A work-count budget, not a flaky wall-clock threshold. Independent of archive/location count.
          expect(scans).toHaveLength(0);
          expect(reads.length).toBeLessThanOrEqual(8);
        }
        const prompt = prompts[1] ?? "";
        const reference = /immediate parent: ([^. ]+)/.exec(prompt)?.[1] ?? "";
        expect(resolveSessionReference(reference, [parent, child, collision])).toEqual({
          ok: true,
          sessionId: parent,
        });
        expect(prompt).toContain(f.workingDirectory);
        expect(prompt).toContain(f.family.familyId);
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.provide(PlatformLive)),
  30000,
);
