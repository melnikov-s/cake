import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Deferred, Effect, Fiber, FileSystem, Layer, Path, PlatformError, Schema } from "effect";
import {
  APPLICATION_DOCUMENT_NAME,
  ApplicationDecodeError,
  ApplicationMalformedDocumentError,
  ApplicationMigrationError,
  ApplicationStorage,
  ApplicationUnsupportedVersionError,
  ApplicationWriteError,
  makeApplicationStorageLive,
} from "../../../../src/services/storage/ApplicationStorage";
import { defaultApplicationState } from "../../../../src/domain/application-data";

interface FakeFileSystemControls {
  readonly files: Map<string, string>;
  readonly temporaryFiles: () => ReadonlyArray<string>;
  readonly releaseWrites: Deferred.Deferred<void>;
  blockWrites: boolean;
  interruptWrite: boolean;
  failRead: boolean;
  failWrite: boolean;
  failRename: boolean;
  activeWrites: number;
  maximumActiveWrites: number;
}

const failure = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "TestFileSystem",
    method,
  });

const makeFakeFileSystem = Effect.fn("makeFakeFileSystem")(function* (
  initial?: Readonly<Record<string, string>>,
) {
  const controls: FakeFileSystemControls = {
    files: new Map(Object.entries(initial ?? {})),
    temporaryFiles: () => [...controls.files.keys()].filter((path) => path.endsWith(".tmp")),
    releaseWrites: yield* Deferred.make<void>(),
    blockWrites: false,
    interruptWrite: false,
    failRead: false,
    failWrite: false,
    failRename: false,
    activeWrites: 0,
    maximumActiveWrites: 0,
  };
  const fileSystem = FileSystem.makeNoop({
    exists: (path) => Effect.succeed(controls.files.has(path)),
    readFileString: (path) => {
      const value = controls.files.get(path);
      return controls.failRead || value === undefined
        ? Effect.fail(failure("readFileString"))
        : Effect.succeed(value);
    },
    writeFileString: (path, content) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          controls.activeWrites += 1;
          controls.maximumActiveWrites = Math.max(
            controls.maximumActiveWrites,
            controls.activeWrites,
          );
        }),
        () => {
          if (controls.failWrite) return Effect.fail(failure("writeFileString"));
          controls.files.set(path, content);
          if (controls.interruptWrite) return Effect.never;
          return controls.blockWrites ? Deferred.await(controls.releaseWrites) : Effect.void;
        },
        () =>
          Effect.sync(() => {
            controls.activeWrites -= 1;
          }),
      ),
    chmod: () => Effect.void,
    rename: (source, target) => {
      if (controls.failRename) return Effect.fail(failure("rename"));
      const value = controls.files.get(source);
      if (value === undefined) return Effect.fail(failure("rename"));
      controls.files.set(target, value);
      controls.files.delete(source);
      return Effect.void;
    },
    remove: (path) =>
      Effect.sync(() => {
        controls.files.delete(path);
      }),
  });
  return { controls, fileSystem };
});

const documentPath = `data/${APPLICATION_DOCUMENT_NAME}`;
const current = defaultApplicationState();
const legacy = {
  schemaVersion: 1,
  projects: [],
  resolvedSessionIds: ["session-1"],
  resolvedCakeChatSessionIds: [],
  unreadSessionIds: [],
  trustedProjectPaths: [],
};

const withStorage = <A, E>(
  initial: Readonly<Record<string, string>>,
  use: (
    storage: ApplicationStorage["Service"],
    controls: FakeFileSystemControls,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fake = yield* makeFakeFileSystem(initial);
    const layer = makeApplicationStorageLive("data").pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem)(fake.fileSystem)),
      Layer.provide(Path.layer),
    );
    return yield* Effect.gen(function* () {
      const storage = yield* ApplicationStorage;
      return yield* use(storage, fake.controls);
    }).pipe(Effect.provide(layer));
  });

const itEffect = (name: string, body: () => Effect.Effect<void, unknown>) =>
  it(name, () => Effect.runPromise(body()));

const waitFor = Effect.fn("waitFor")(function* (predicate: () => boolean) {
  while (!predicate()) yield* Effect.yieldNow;
});

describe("ApplicationStorage", () => {
  itEffect("uses explicit defaults for a missing file", () =>
    withStorage({}, (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load;
        assert.strictEqual(loaded.source, "missing");
        assert.deepStrictEqual(loaded.state, current);
      }),
    ),
  );

  itEffect("returns a typed read failure", () =>
    withStorage({ [documentPath]: "unreadable" }, (storage, controls) =>
      Effect.gen(function* () {
        controls.failRead = true;
        const error = yield* Effect.flip(storage.load);
        assert.equal(error._tag, "ApplicationReadError");
      }),
    ),
  );

  itEffect("loads a current version envelope", () =>
    withStorage({ [documentPath]: JSON.stringify({ version: 1, data: current }) }, (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load;
        assert.strictEqual(loaded.source, "current");
        assert.deepStrictEqual(loaded.state, current);
      }),
    ),
  );

  itEffect("migrates recognized legacy and version-zero documents", () =>
    Effect.gen(function* () {
      for (const input of [legacy, { version: 0, data: legacy }]) {
        yield* withStorage({ [documentPath]: JSON.stringify(input) }, (storage, controls) =>
          Effect.gen(function* () {
            const loaded = yield* storage.load;
            assert.strictEqual(loaded.source, "migrated");
            assert.deepStrictEqual(loaded.state.resolvedSessionIds, ["session-1"]);
            const persisted = JSON.parse(controls.files.get(documentPath)!);
            assert.strictEqual(persisted.version, 1);
            assert.ok(!("schemaVersion" in persisted.data));
          }),
        );
      }
    }),
  );

  itEffect("returns typed failures for malformed, future, and invalid documents", () =>
    Effect.gen(function* () {
      const cases = [
        ["{", ApplicationMalformedDocumentError],
        [JSON.stringify({ nope: true }), ApplicationMalformedDocumentError],
        [
          JSON.stringify({ version: 1, data: { ...current, projects: "invalid" } }),
          ApplicationDecodeError,
        ],
        [JSON.stringify({ version: 2, data: current }), ApplicationUnsupportedVersionError],
        [
          JSON.stringify({ version: 0, data: { schemaVersion: 1, projects: "invalid" } }),
          ApplicationMigrationError,
        ],
      ] as const;
      for (const [content, ErrorSchema] of cases) {
        yield* withStorage({ [documentPath]: content }, (storage) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(storage.load);
            assert.ok(Schema.is(ErrorSchema)(error));
          }),
        );
      }
    }),
  );

  itEffect(
    "keeps the previous file and cleans temporary files after write and rename failure",
    () =>
      Effect.gen(function* () {
        for (const stage of ["write", "rename"] as const) {
          yield* withStorage({ [documentPath]: "previous" }, (storage, controls) =>
            Effect.gen(function* () {
              controls.failWrite = stage === "write";
              controls.failRename = stage === "rename";
              const error = yield* Effect.flip(storage.save(current));
              assert.ok(Schema.is(ApplicationWriteError)(error));
              if (error._tag !== "ApplicationWriteError") throw error;
              assert.strictEqual(error.stage, stage);
              assert.strictEqual(controls.files.get(documentPath), "previous");
              assert.deepStrictEqual(controls.temporaryFiles(), []);
            }),
          );
        }
      }),
  );

  itEffect("cleans a temporary file when an in-progress write is interrupted", () =>
    withStorage({ [documentPath]: "previous" }, (storage, controls) =>
      Effect.gen(function* () {
        controls.interruptWrite = true;
        const fiber = yield* Effect.forkChild(storage.save(current));
        yield* waitFor(() => controls.temporaryFiles().length === 1);
        yield* Fiber.interrupt(fiber);
        assert.strictEqual(controls.files.get(documentPath), "previous");
        assert.deepStrictEqual(controls.temporaryFiles(), []);
      }),
    ),
  );

  itEffect("serializes concurrent writes", () =>
    withStorage({}, (storage, controls) =>
      Effect.gen(function* () {
        controls.blockWrites = true;
        const first = yield* Effect.forkChild(storage.save(current));
        yield* waitFor(() => controls.activeWrites === 1);
        const second = yield* Effect.forkChild(storage.save(current));
        yield* Effect.yieldNow;
        assert.strictEqual(controls.activeWrites, 1);
        assert.strictEqual(controls.maximumActiveWrites, 1);
        yield* Deferred.succeed(controls.releaseWrites, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        assert.strictEqual(controls.maximumActiveWrites, 1);
      }),
    ),
  );
});
