import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { expect, vi } from "vitest";
import { initialize } from "../../../src/domain/session-families/sessionFamilies";
import {
  SessionFamilyStorage,
  makeSessionFamilyStorageLive,
} from "../../../src/services/storage/SessionFamilyStorage";
import { SessionArchiveStorage } from "../../../src/services/storage/SessionArchiveStorage";
import { makeSessionArchiveStorageLive } from "../../../src/services/storage/SessionArchiveStorageLive";
import { DOCUMENT_VERSION } from "../../../src/services/storage/sessionFamilyDocumentCodec";
import * as sessionFiles from "../../../src/services/storage/session-files";
import { loadWorkspacePiSessionSummary } from "../../../src/services/pi/runtime/session-discovery";

const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer);

// Read-only reference for the discovery portion at 9d1af8da. Fixtures contain
// only protected or materialized children, so neither implementation mutates them.
const previousFamilyDiscovery = Effect.fn("StartupRecovery.test.previousFamilyDiscovery")(
  function* (activeRoot: string, resolvedRoot: string) {
    const storage = yield* SessionFamilyStorage;
    const archive = yield* SessionArchiveStorage;
    for (const family of yield* storage.list()) {
      for (const child of family.children) {
        if (
          yield* archive.locate(child.sessionId, {
            cwd: child.workingDirectory,
            activeRoot,
            resolvedRoot,
          })
        )
          continue;
        if ((yield* storage.state()).turns.some((turn) => turn.sessionId === child.sessionId))
          continue;
        return yield* Effect.die("Unexpected unprotected fixture member");
      }
    }
    yield* storage.state();
    yield* storage.state();
  },
);

it.effect("measures empty/heavy family discovery with real isolated metadata and archive IO", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-startup-recovery-" });
    for (const retained of [0, 400]) {
      const cwd = `${directory}/${retained}`;
      const activeRoot = `${cwd}/active`;
      const resolvedRoot = `${cwd}/resolved`;
      const documentPath = `${cwd}/families.json`;
      yield* fs.makeDirectory(cwd, { recursive: true });
      const children = Array.from({ length: retained }, (_, index) => ({
        sessionId: `child-${index}`,
        parentSessionId: "parent",
        requestId: `request-${index}`,
        workingDirectory: cwd,
        createdAt: "2026-01-01",
      }));
      const turns = children.map((child) => ({
        sessionId: child.sessionId,
        senderSessionId: "parent",
        turnId: child.requestId,
        requestMessageId: child.requestId,
        threadId: "family",
        reported: false,
        outcome: "complete",
      }));
      yield* fs.writeFileString(
        documentPath,
        JSON.stringify({
          version: DOCUMENT_VERSION,
          data: {
            families: retained
              ? [
                  {
                    familyId: "family",
                    parentSessionId: "parent",
                    projectPath: cwd,
                    workingDirectory: cwd,
                    createdAt: "2026-01-01",
                    children,
                  },
                ]
              : [],
            turns,
            spawnedSessions: [],
          },
        }),
      );
      const exact = vi.spyOn(sessionFiles, "findSessionFileById");
      const batch = vi.spyOn(sessionFiles, "findSessionFilesByIds");
      try {
        const results = [];
        for (const mode of ["before", "after"] as const) {
          let freshnessChecks = 0;
          const measuredFs = FileSystem.makeNoop({
            ...fs,
            stat: (path) => {
              if (path === documentPath) freshnessChecks++;
              return fs.stat(path);
            },
          });
          const services = Layer.mergeAll(
            makeSessionFamilyStorageLive(documentPath),
            makeSessionArchiveStorageLive(`${cwd}/archive`, { activeRoot, resolvedRoot }),
          ).pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(FileSystem.FileSystem, measuredFs), NodePath.layer),
            ),
          );
          exact.mockClear();
          batch.mockClear();
          const started = performance.now();
          yield* (
            mode === "before"
              ? previousFamilyDiscovery(activeRoot, resolvedRoot)
              : initialize(activeRoot, resolvedRoot, () => Effect.succeed(false))
          ).pipe(Effect.provide(services));
          results.push({
            mode,
            elapsedMs: performance.now() - started,
            exactLookups: exact.mock.calls.length,
            batchLookups: batch.mock.calls.length,
            freshnessChecks,
          });
        }
        expect(results[0]?.exactLookups).toBe(retained);
        expect(results[1]?.exactLookups).toBe(0);
        expect(results[0]?.freshnessChecks).toBe(retained + 3);
        expect(results[1]?.freshnessChecks).toBe(3);
        console.info("Recovery fixture (discovery only; not end-to-end startup)", {
          retained,
          results,
        });
      } finally {
        exact.mockRestore();
        batch.mockRestore();
      }
    }
  }).pipe(Effect.provide(platform)),
);

it.effect(
  "measures recovery presence versus cold title loading without opening transcripts twice",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cake-recovery-titles-" });
      const sessions = Array.from({ length: 12 }, (_, index) => `session-${index}`);
      const timestamp = "2026-01-01T00:00:00.000Z";
      for (const id of sessions) {
        const entries = [
          JSON.stringify({ type: "session", version: 3, id, cwd: directory, timestamp }),
        ];
        for (let index = 0; index < 1000; index++)
          entries.push(
            JSON.stringify({
              type: "message",
              id: `entry-${index}`,
              parentId: index ? `entry-${index - 1}` : null,
              timestamp,
              message: {
                role: "user",
                content: "Representative retained transcript content ".repeat(4),
                timestamp: 0,
              },
            }),
          );
        yield* fs.writeFileString(
          `${directory}/2026-01-01T00-00-00-000Z_${id}.jsonl`,
          `${entries.join("\n")}\n`,
        );
      }
      const opened = vi.spyOn(SessionManager, "open");
      try {
        const before = performance.now();
        for (const id of sessions)
          yield* Effect.promise(() =>
            loadWorkspacePiSessionSummary(directory, id, directory, { direct: true }),
          );
        const titleMs = performance.now() - before;
        expect(opened).toHaveBeenCalledTimes(sessions.length);
        opened.mockClear();
        const after = performance.now();
        for (const id of sessions)
          expect(
            yield* Effect.promise(() =>
              sessionFiles.hasSessionFileById(id, {
                workingDirectory: directory,
                root: directory,
                direct: true,
              }),
            ),
          ).toBe(true);
        const presenceMs = performance.now() - after;
        expect(opened).not.toHaveBeenCalled();
        console.info("Recovery fixture (discovery only; runtime construction unchanged)", {
          sessions: sessions.length,
          entriesPerSession: 1000,
          titleMs,
          presenceMs,
          titleTranscriptOpens: sessions.length,
          presenceTranscriptOpens: opened.mock.calls.length,
        });
      } finally {
        opened.mockRestore();
      }
    }).pipe(Effect.provide(platform)),
);
