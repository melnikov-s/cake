import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError } from "effect";
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared";
import { describe } from "vitest";
import {
  DrawBoardId,
  DrawBoardTitle,
  DrawSessionId,
} from "../../../../src/domain/draw/draw-board-data";
import {
  DRAW_BOARD_SNAPSHOT_MAX_BYTES,
  DrawBoardStorage,
} from "../../../../src/services/storage/DrawBoardStorage";
import { makeDrawBoardStorageLive } from "../../../../src/services/storage/DrawBoardStorageLive";

const TestPlatformLive = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);
const boardId = DrawBoardId.make("00000000-0000-4000-8000-000000000001");
const sessionId = DrawSessionId.make("session-1");
const otherSessionId = DrawSessionId.make("session-2");
const title = DrawBoardTitle.make("Architecture sketch");

const fileSystemFailure = (method: string) =>
  PlatformError.systemError({
    _tag: "Unknown",
    module: "DrawBoardStorageTest",
    method,
  });

const run = <A, E>(
  root: string,
  use: (storage: DrawBoardStorage["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const storage = yield* DrawBoardStorage;
    return yield* use(storage);
  }).pipe(Effect.provide(makeDrawBoardStorageLive(root)), Effect.provide(TestPlatformLive));

const withCatalogRenameFault = <A, E>(
  root: string,
  use: (
    storage: DrawBoardStorage["Service"],
    controls: {
      readonly failNextCatalogRename: () => void;
      readonly exists: (target: string) => Effect.Effect<boolean>;
    },
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    let failCatalogRename = false;
    const catalogPath = join(root, "catalog.json");
    const controlledFileSystem = FileSystem.makeNoop({
      ...fileSystem,
      rename: (source, target) => {
        if (failCatalogRename && target === catalogPath) {
          failCatalogRename = false;
          return Effect.fail(fileSystemFailure("rename"));
        }
        return fileSystem.rename(source, target);
      },
    });
    const controlledPlatform = Layer.mergeAll(
      Layer.succeed(FileSystem.FileSystem)(controlledFileSystem),
      NodePath.layer,
    );
    return yield* Effect.gen(function* () {
      const storage = yield* DrawBoardStorage;
      return yield* use(storage, {
        failNextCatalogRename: () => {
          failCatalogRename = true;
        },
        exists: (target) => fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false)),
      });
    }).pipe(Effect.provide(makeDrawBoardStorageLive(root)), Effect.provide(controlledPlatform));
  }).pipe(Effect.provide(TestPlatformLive));

describe("DrawBoardStorage", () => {
  it.effect("creates, lists, reads, saves, renames, and deletes a board", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "cake-draw-")));
      const created = {
        id: boardId,
        sessionId,
        title,
        revision: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } as const;

      yield* run(root, (storage) => storage.create(created));
      assert.deepEqual(yield* run(root, (storage) => storage.list(sessionId)), [created]);
      assert.deepEqual(yield* run(root, (storage) => storage.read(sessionId, boardId)), {
        board: created,
        snapshot: null,
      });

      const saved = yield* run(root, (storage) =>
        storage.save(
          sessionId,
          boardId,
          0,
          { store: { page: "page:1" } },
          "2026-01-02T00:00:00.000Z",
        ),
      );
      assert.equal(saved.revision, 1);
      const renamed = yield* run(root, (storage) =>
        storage.rename(
          sessionId,
          boardId,
          DrawBoardTitle.make("Renamed board"),
          "2026-01-03T00:00:00.000Z",
        ),
      );
      assert.equal(renamed.title, "Renamed board");
      assert.deepEqual((yield* run(root, (storage) => storage.read(sessionId, boardId))).snapshot, {
        store: { page: "page:1" },
      });

      yield* run(root, (storage) => storage.delete(sessionId, boardId));
      assert.deepEqual(yield* run(root, (storage) => storage.list(sessionId)), []);
    }),
  );

  it.effect("enforces session association and expected revision", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "cake-draw-")));
      yield* run(root, (storage) =>
        storage.create({
          id: boardId,
          sessionId,
          title,
          revision: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );

      const associationFailure = yield* run(root, (storage) =>
        storage.read(otherSessionId, boardId).pipe(Effect.flip),
      );
      assert.equal(associationFailure.code, "not-found");
      const conflict = yield* run(root, (storage) =>
        storage.save(sessionId, boardId, 2, {}, "2026-01-02T00:00:00.000Z").pipe(Effect.flip),
      );
      assert.equal(conflict.code, "revision-conflict");
    }),
  );

  it.effect("rolls back board files when catalog publication fails", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "cake-draw-")));
      yield* withCatalogRenameFault(root, (storage, controls) =>
        Effect.gen(function* () {
          const original = {
            id: boardId,
            sessionId,
            title,
            revision: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          } as const;
          yield* storage.create(original);
          const saved = yield* storage.save(
            sessionId,
            boardId,
            0,
            { store: "original" },
            "2026-01-02T00:00:00.000Z",
          );
          const originalDocument = {
            board: saved,
            snapshot: { store: "original" },
          } as const;

          controls.failNextCatalogRename();
          const saveFailure = yield* storage
            .save(
              sessionId,
              boardId,
              saved.revision,
              { store: "unpublished" },
              "2026-01-03T00:00:00.000Z",
            )
            .pipe(Effect.flip);
          assert.equal(saveFailure.code, "storage");
          assert.deepEqual(yield* storage.read(sessionId, boardId), originalDocument);

          controls.failNextCatalogRename();
          const renameFailure = yield* storage
            .rename(
              sessionId,
              boardId,
              DrawBoardTitle.make("Unpublished title"),
              "2026-01-04T00:00:00.000Z",
            )
            .pipe(Effect.flip);
          assert.equal(renameFailure.code, "storage");
          assert.deepEqual(yield* storage.read(sessionId, boardId), originalDocument);

          const unpublishedId = DrawBoardId.make("00000000-0000-4000-8000-000000000099");
          controls.failNextCatalogRename();
          const createFailure = yield* storage
            .create({
              ...original,
              id: unpublishedId,
              title: DrawBoardTitle.make("Unpublished board"),
            })
            .pipe(Effect.flip);
          assert.equal(createFailure.code, "storage");
          assert.equal(
            yield* controls.exists(join(root, "boards", `${unpublishedId}.json`)),
            false,
          );
          assert.equal(
            (yield* storage.read(sessionId, unpublishedId).pipe(Effect.flip)).code,
            "not-found",
          );
        }),
      );
    }),
  );

  it.effect("rejects oversized snapshots without advancing the revision", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "cake-draw-")));
      yield* run(root, (storage) =>
        storage.create({
          id: boardId,
          sessionId,
          title,
          revision: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        }),
      );
      const failure = yield* run(root, (storage) =>
        storage
          .save(
            sessionId,
            boardId,
            0,
            { image: "x".repeat(DRAW_BOARD_SNAPSHOT_MAX_BYTES) },
            "2026-01-02T00:00:00.000Z",
          )
          .pipe(Effect.flip),
      );
      assert.equal(failure.code, "snapshot-too-large");
      assert.equal(
        (yield* run(root, (storage) => storage.read(sessionId, boardId))).board.revision,
        0,
      );
    }),
  );

  it.effect("removes all boards for a permanently deleted session", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "cake-draw-")));
      yield* run(root, (storage) =>
        Effect.forEach(
          [sessionId, otherSessionId],
          (owner, index) =>
            storage.create({
              id: DrawBoardId.make(`00000000-0000-4000-8000-00000000000${index + 1}`),
              sessionId: owner,
              title,
              revision: 0,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            }),
          { discard: true },
        ),
      );
      yield* run(root, (storage) => storage.deleteSession(sessionId));
      assert.deepEqual(yield* run(root, (storage) => storage.list(sessionId)), []);
      assert.equal((yield* run(root, (storage) => storage.list(otherSessionId))).length, 1);
      assert.deepEqual(
        yield* run(root, (storage) =>
          storage.read(otherSessionId, DrawBoardId.make("00000000-0000-4000-8000-000000000002")),
        ),
        {
          board: {
            id: DrawBoardId.make("00000000-0000-4000-8000-000000000002"),
            sessionId: otherSessionId,
            title,
            revision: 0,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          snapshot: null,
        },
      );
      const catalog = JSON.parse(
        yield* Effect.promise(() => readFile(join(root, "catalog.json"), "utf8")),
      );
      assert.equal(catalog.boards.length, 1);
    }),
  );
});
