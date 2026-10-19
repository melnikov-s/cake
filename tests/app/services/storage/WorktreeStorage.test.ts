import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, Ref, Result } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vitest";
import type { WorktreeRecord } from "../../../../src/contracts/worktrees/managed-worktree-data";
import { Git } from "../../../../src/services/git/Git";
import { WorktreeStorage } from "../../../../src/services/storage/WorktreeStorage";
import { makeWorktreeStorageLive } from "../../../../src/services/storage/WorktreeStorageLive";
import { createCheckout } from "../../../../src/domain/worktrees/worktreeCreation";
import { ManagedWorktreesLive } from "../../../../src/services/worktrees/ManagedWorktreesLive";

const record = (index: number): WorktreeRecord => ({
  projectPath: "/project",
  worktreePath: `/worktrees/task-${index}`,
  branch: `agent/task-${index}`,
  baseBranch: "main",
  createdAt: "2026-01-01T00:00:00.000Z",
  state: index === 0 ? "active" : "resolved",
});
const document = (records: ReadonlyArray<WorktreeRecord>) =>
  JSON.stringify({ schemaVersion: 1, records }, null, 2);

const fixture = <A, E, R>(work: (storagePath: string) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "cake-worktree-storage-",
      });
      const storagePath = path.join(directory, "state", "worktrees.json");
      return yield* work(storagePath).pipe(Effect.provide(makeWorktreeStorageLive(storagePath)));
    }),
  ).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)));

const writeCatalog = Effect.fn("WorktreeStorageTest.writeCatalog")(function* (
  storagePath: string,
  content: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(storagePath), { recursive: true });
  yield* fileSystem.writeFileString(storagePath, content);
});

const invalidCatalogs = [
  { name: "version 2", content: JSON.stringify({ schemaVersion: 2, records: [record(0)] }) },
  {
    name: "malformed records",
    content: JSON.stringify({ schemaVersion: 1, records: [record(0), { branch: "agent/broken" }] }),
  },
  { name: "malformed JSON", content: '{ "schemaVersion": 1, "records": [\n' },
  { name: "missing version", content: JSON.stringify({ records: [record(0)] }) },
  { name: "missing records", content: JSON.stringify({ schemaVersion: 1 }) },
  { name: "non-array records", content: JSON.stringify({ schemaVersion: 1, records: {} }) },
  { name: "empty object", content: "{}" },
];

describe("WorktreeStorage", () => {
  it.effect("treats only a missing catalog as empty and saves a valid catalog on first use", () =>
    fixture((storagePath) =>
      Effect.gen(function* () {
        const storage = yield* WorktreeStorage;
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* storage.load()).toEqual([]);
        expect(yield* fileSystem.exists(storagePath)).toBe(false);
        yield* storage.save([record(0)]);
        expect(JSON.parse(yield* fileSystem.readFileString(storagePath))).toEqual({
          schemaVersion: 1,
          records: [record(0)],
        });
        expect(yield* storage.load()).toEqual([record(0)]);
      }),
    ),
  );

  it.effect.each(invalidCatalogs)(
    "rejects $name, preserves its bytes, and prevents creation from saving a replacement catalog",
    ({ content }) =>
      fixture((storagePath) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const storage = yield* WorktreeStorage;
          yield* writeCatalog(storagePath, content);
          const original = yield* fileSystem.readFile(storagePath);
          const loaded = yield* Effect.result(storage.load());
          expect(loaded).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "WorktreeStorageError", operation: "WorktreeStorage.load" },
          });
          if (Result.isFailure(loaded)) {
            expect(loaded.failure.message).toContain(storagePath);
            expect(loaded.failure.message).toContain("Cannot decode worktree catalog");
          }
          const saves = yield* Ref.make(0);
          const gitCalls = yield* Ref.make(0);
          const engine = ManagedWorktreesLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(WorktreeStorage, {
                  load: storage.load,
                  save: (records) =>
                    Ref.update(saves, (count) => count + 1).pipe(
                      Effect.andThen(storage.save(records)),
                    ),
                }),
                Layer.mock(Git, {
                  run: () => Ref.update(gitCalls, (count) => count + 1).pipe(Effect.as("")),
                }),
                Layer.mock(ChildProcessSpawner.ChildProcessSpawner, {}),
              ),
            ),
          );
          const created = yield* Effect.result(
            createCheckout(path.join(path.dirname(storagePath), "project")).pipe(
              Effect.provide(engine),
            ),
          );
          expect(created).toEqual(loaded);
          expect(yield* Ref.get(saves)).toBe(0);
          expect(yield* Ref.get(gitCalls)).toBe(0);
          expect(yield* fileSystem.readFile(storagePath)).toEqual(original);
          expect(yield* fileSystem.readDirectory(path.dirname(storagePath))).toEqual([
            "worktrees.json",
          ]);
        }),
      ),
  );

  it.effect(
    "fails explicitly on an unreadable catalog rather than returning an empty catalog",
    () =>
      fixture((storagePath) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const storage = yield* WorktreeStorage;
          yield* fileSystem.makeDirectory(storagePath, { recursive: true });
          expect(yield* Effect.result(storage.load())).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "WorktreeStorageError", operation: "WorktreeStorage.load" },
          });
          expect((yield* fileSystem.stat(storagePath)).type).toBe("Directory");
        }),
      ),
  );

  it.effect("preserves the pre-resolution classification when reopening retired worktrees", () =>
    fixture((storagePath) =>
      Effect.gen(function* () {
        const records: ReadonlyArray<WorktreeRecord> = [
          { ...record(1), resolvedFrom: "landed" },
          { ...record(2), resolvedFrom: "discarded" },
        ];
        const storage = yield* WorktreeStorage;
        yield* storage.save(records);
        expect(
          yield* Effect.flatMap(WorktreeStorage, (reopened) => reopened.load()).pipe(
            Effect.provide(makeWorktreeStorageLive(storagePath)),
          ),
        ).toEqual(records);
      }),
    ),
  );

  it.effect("persists the acknowledged source checkpoint independently of the original base", () =>
    fixture((storagePath) =>
      Effect.gen(function* () {
        const records = [
          {
            ...record(0),
            state: "landed" as const,
            baseCommit: "original-base",
            landedSourceCommit: "last-landed-source",
          },
        ];
        const storage = yield* WorktreeStorage;
        yield* storage.save(records);
        expect(
          yield* Effect.flatMap(WorktreeStorage, (reopened) => reopened.load()).pipe(
            Effect.provide(makeWorktreeStorageLive(storagePath)),
          ),
        ).toEqual(records);
      }),
    ),
  );

  it.effect("loads a catalog larger than 500 without dropping active or historical records", () =>
    fixture((storagePath) =>
      Effect.gen(function* () {
        const records = Array.from({ length: 1_001 }, (_, index) => record(index));
        const storage = yield* WorktreeStorage;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* writeCatalog(storagePath, document(records));
        expect(yield* storage.load()).toEqual(records);
        expect(yield* fileSystem.readFileString(storagePath)).toBe(document(records));
      }),
    ),
  );

  it.effect("saves the 501st worktree and preserves the complete catalog when reopened", () =>
    fixture((storagePath) =>
      Effect.gen(function* () {
        const initial = Array.from({ length: 500 }, (_, index) => record(index));
        const expanded = [...initial, { ...record(500), state: "active" as const }];
        const storage = yield* WorktreeStorage;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeCatalog(storagePath, document(initial));
        expect(yield* storage.load()).toEqual(initial);
        yield* storage.save(expanded);
        expect(JSON.parse(yield* fileSystem.readFileString(storagePath))).toEqual({
          schemaVersion: 1,
          records: expanded,
        });
        expect(
          yield* Effect.flatMap(WorktreeStorage, (reopened) => reopened.load()).pipe(
            Effect.provide(makeWorktreeStorageLive(storagePath)),
          ),
        ).toEqual(expanded);
        expect(yield* fileSystem.readDirectory(path.dirname(storagePath))).toEqual([
          "worktrees.json",
        ]);
      }),
    ),
  );
});
