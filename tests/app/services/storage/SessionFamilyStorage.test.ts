import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { describe } from "vitest";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import {
  SessionFamilyStorage,
  makeSessionFamilyStorageLive,
} from "../../../../src/services/storage/SessionFamilyStorage";

const failure = (method: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "SessionFamilyStorageTest", method });

const testLayer = () => {
  const files = new Map<string, string>();
  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(files.has(path)),
    readFileString: (path) => {
      const value = files.get(path);
      return value === undefined ? Effect.fail(failure("readFileString")) : Effect.succeed(value);
    },
    writeFileString: (path, content) => Effect.sync(() => files.set(path, content)),
    chmod: () => Effect.void,
    rename: (source, target) =>
      Effect.gen(function* () {
        const value = files.get(source);
        if (value === undefined) return yield* Effect.fail(failure("rename"));
        files.set(target, value);
        files.delete(source);
      }),
    remove: (path) => Effect.sync(() => files.delete(path)),
  });
  return makeSessionFamilyStorageLive("state/session-families.json").pipe(
    Layer.provide(Layer.succeed(FileSystem.FileSystem)(fileSystem)),
    Layer.provide(Path.layer),
  );
};

const child = (requestId: string, childSessionId: string) => ({
  familyId: crypto.randomUUID(),
  parentSessionId: "parent",
  childSessionId,
  requestId,
  projectPath: "/project",
  workingDirectory: "/project/.cake-worktrees/feature",
  managedWorktreePath: "/project/.cake-worktrees/feature",
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("SessionFamilyStorage", () => {
  it.effect("serializes concurrent first-child creation into one family", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const [first, second] = yield* Effect.all(
        [
          storage.addChild(child("request-1", "child-1")),
          storage.addChild(child("request-2", "child-2")),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(first.familyId, second.familyId);
      const families = yield* storage.list();
      assert.equal(families.length, 1);
      assert.deepEqual(families[0]?.children.map((entry) => entry.sessionId).sort(), [
        "child-1",
        "child-2",
      ]);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("returns the original child for an idempotent creation request", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      const original = yield* storage.addChild(child("request-1", "child-1"));
      const retried = yield* storage.addChild(child("request-1", "different-child"));
      assert.equal(retried.familyId, original.familyId);
      assert.deepEqual(retried.children, original.children);
    }).pipe(Effect.provide(testLayer())),
  );

  it.effect("rejects grandchildren and Working Directory changes", () =>
    Effect.gen(function* () {
      const storage = yield* SessionFamilyStorage;
      yield* storage.addChild(child("request-1", "child-1"));
      const grandchildError = yield* Effect.flip(
        storage.addChild({ ...child("request-2", "grandchild"), parentSessionId: "child-1" }),
      );
      assert.match(grandchildError.message, /cannot create children/);
      const movedError = yield* Effect.flip(
        storage.addChild({ ...child("request-3", "child-2"), workingDirectory: "/elsewhere" }),
      );
      assert.match(movedError.message, /cannot change/);
    }).pipe(Effect.provide(testLayer())),
  );
});
