import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import { describe, expect } from "vitest";
import type { WorktreeRecord } from "../../../../src/contracts/worktrees/managed-worktree-data";
import { WorktreeStorage } from "../../../../src/services/storage/WorktreeStorage";
import { makeWorktreeStorageLive } from "../../../../src/services/storage/WorktreeStorageLive";

const storagePath = "state/worktrees.json";
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

const storageLayer = (files: Map<string, string>) => {
  const missingFile = (method: string) =>
    PlatformError.systemError({ _tag: "NotFound", module: "WorktreeStorageTest", method });
  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => {
      const content = files.get(path);
      return content === undefined
        ? Effect.fail(missingFile("readFileString"))
        : Effect.succeed(content);
    },
    writeFileString: (path, content) => Effect.sync(() => files.set(path, content)),
    makeDirectory: () => Effect.void,
    chmod: () => Effect.void,
    rename: (source, target) =>
      Effect.gen(function* () {
        const content = files.get(source);
        if (content === undefined) return yield* missingFile("rename");
        files.set(target, content);
        files.delete(source);
      }),
    remove: (path) => Effect.sync(() => files.delete(path)),
  });
  return makeWorktreeStorageLive(storagePath).pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem)(fileSystem)),
    Layer.provide(Path.layer),
  );
};

const load = Effect.flatMap(WorktreeStorage, (storage) => storage.load());

describe("WorktreeStorage", () => {
  it.effect("preserves the pre-resolution classification when reopening retired worktrees", () => {
    const records: ReadonlyArray<WorktreeRecord> = [
      { ...record(1), resolvedFrom: "landed" },
      { ...record(2), resolvedFrom: "discarded" },
    ];
    const files = new Map<string, string>();
    return Effect.gen(function* () {
      yield* Effect.flatMap(WorktreeStorage, (storage) => storage.save(records)).pipe(
        Effect.provide(storageLayer(files)),
      );
      expect(yield* load.pipe(Effect.provide(storageLayer(files)))).toEqual(records);
    });
  });

  it.effect("loads a catalog larger than 500 without dropping active or historical records", () => {
    const records = Array.from({ length: 1_001 }, (_, index) => record(index));
    const files = new Map([[storagePath, document(records)]]);
    return Effect.gen(function* () {
      expect(yield* load).toEqual(records);
      expect(files.get(storagePath)).toBe(document(records));
    }).pipe(Effect.provide(storageLayer(files)));
  });

  it.effect("saves the 501st worktree and preserves the complete catalog when reopened", () => {
    const initial = Array.from({ length: 500 }, (_, index) => record(index));
    const files = new Map([[storagePath, document(initial)]]);
    const expanded = [...initial, { ...record(500), state: "active" as const }];
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const storage = yield* WorktreeStorage;
        expect(yield* storage.load()).toEqual(initial);
        yield* storage.save(expanded);
      }).pipe(Effect.provide(storageLayer(files)));
      expect(JSON.parse(files.get(storagePath) ?? "{}")).toEqual({
        schemaVersion: 1,
        records: expanded,
      });
      expect(yield* load.pipe(Effect.provide(storageLayer(files)))).toEqual(expanded);
      expect([...files.keys()]).toEqual([storagePath]);
    });
  });
});
