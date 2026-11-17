import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { expect } from "vitest";
import { initialize } from "../../../src/domain/session-families/sessionFamilies";
import {
  SessionFamilyStorage,
  makeSessionFamilyStorageLive,
} from "../../../src/services/storage/SessionFamilyStorage";
import { makeSessionArchiveStorageLive } from "../../../src/services/storage/SessionArchiveStorageLive";
import { DOCUMENT_VERSION } from "../../../src/services/storage/sessionFamilyDocumentCodec";

it.effect(
  "recovers protected families within a fixed metadata IO budget regardless of history size",
  () =>
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
        yield* Effect.gen(function* () {
          yield* initialize(activeRoot, resolvedRoot, () => Effect.succeed(false));
          // Recovery must not perform one metadata freshness check per retained child.
          expect(freshnessChecks).toBeLessThanOrEqual(3);
          const recovered = yield* (yield* SessionFamilyStorage).state();
          expect(recovered.turns).toEqual(turns);
          expect(recovered.families.flatMap((family) => family.children)).toEqual(children);
        }).pipe(Effect.provide(services));
      }
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer))),
);
