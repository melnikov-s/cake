import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { describe } from "vitest";
import { Effect, FileSystem, Layer, Path, PlatformError } from "effect";
import {
  makeWindowStateStorageLive,
  WindowStateStorage,
} from "../../../../src/services/storage/WindowStateStorage";

const documentPath = "data/window-state.json";

const failure = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "TestFileSystem",
    method,
  });

const withStorage = <A, E>(
  content: string | undefined,
  use: (storage: WindowStateStorage["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const files = new Map<string, string>(content === undefined ? [] : [[documentPath, content]]);
    const fileSystem = FileSystem.makeNoop({
      exists: (path) => Effect.succeed(files.has(path)),
      readFileString: (path) => {
        const value = files.get(path);
        return value === undefined ? Effect.fail(failure("readFileString")) : Effect.succeed(value);
      },
      writeFileString: (path, value) =>
        Effect.sync(() => {
          files.set(path, value);
        }),
      makeDirectory: () => Effect.void,
      chmod: () => Effect.void,
      rename: (source, target) => {
        const value = files.get(source);
        if (value === undefined) return Effect.fail(failure("rename"));
        files.set(target, value);
        files.delete(source);
        return Effect.void;
      },
      remove: (path) =>
        Effect.sync(() => {
          files.delete(path);
        }),
    });
    const layer = makeWindowStateStorageLive("data").pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem)(fileSystem)),
      Layer.provide(Path.layer),
    );
    return yield* Effect.gen(function* () {
      const storage = yield* WindowStateStorage;
      return yield* use(storage);
    }).pipe(Effect.provide(layer));
  });

describe("WindowStateStorage", () => {
  const snapshot = {
    state: {},
    children: { composerStore: { state: { draft: "Keep my typed draft" }, children: {} } },
  };

  it.effect("returns an empty snapshot when no document exists", () =>
    Effect.gen(function* () {
      const loaded = yield* withStorage(undefined, (storage) => storage.load());
      assert.deepStrictEqual(loaded, { state: {}, children: {} });
    }),
  );

  it.effect("round-trips the current document version", () =>
    withStorage(undefined, (storage) =>
      Effect.gen(function* () {
        yield* storage.save(snapshot);
        assert.deepStrictEqual(yield* storage.load(), snapshot);
      }),
    ),
  );

  it.effect("rejects other document versions instead of migrating them", () =>
    withStorage(JSON.stringify({ version: 13, data: snapshot }), (storage) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(storage.load());
        assert.strictEqual(error._tag, "WindowStateUnsupportedVersionError");
      }),
    ),
  );

  it.effect("rejects unversioned documents as malformed", () =>
    withStorage(JSON.stringify({ projectPath: "/project" }), (storage) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(storage.load());
        assert.strictEqual(error._tag, "WindowStateMalformedDocumentError");
      }),
    ),
  );
});
