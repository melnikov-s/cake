import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { describe } from "vitest";
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
import { defaultApplicationState } from "../../../../src/domain/application/application-data";
import { ApplicationState } from "../../../../src/services/storage/ApplicationState";
import { updateNonChatModelPreference } from "../../../../src/domain/model-preferences/non-chat-model-preferences";
import {
  defaultCakePrompts,
  resolveCakePrompts,
} from "../../../../src/domain/application/cake-prompts";
import { setCakePrompts } from "../../../../src/domain/application/application";

interface FakeFileSystemControls {
  readonly files: Map<string, string>;
  readonly temporaryFiles: () => ReadonlyArray<string>;
  readonly releaseWrites: Deferred.Deferred<void>;
  readonly writeStarted: Deferred.Deferred<void>;
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
    writeStarted: yield* Deferred.make<void>(),
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
          return Deferred.succeed(controls.writeStarted, undefined).pipe(
            Effect.andThen(
              controls.interruptWrite
                ? Effect.never
                : controls.blockWrites
                  ? Deferred.await(controls.releaseWrites)
                  : Effect.void,
            ),
          );
        },
        () =>
          Effect.sync(() => {
            controls.activeWrites -= 1;
          }),
      ),
    makeDirectory: () => Effect.void,
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

describe("ApplicationStorage", () => {
  it.effect(
    "persists independent backend non-chat preferences, reloads references and leaves chat configuration unchanged",
    () =>
      withStorage({}, (storage) =>
        Effect.gen(function* () {
          const application = yield* ApplicationState;
          yield* application.initialize();
          const image = { provider: "openrouter", modelId: "image" };
          const classifier = { provider: "typesafe", modelId: "jev-latest" };
          yield* updateNonChatModelPreference({ type: "image", preference: image });
          yield* updateNonChatModelPreference({ type: "classifier", preference: classifier });
          const loaded = (yield* storage.load()).state;
          assert.deepEqual(loaded.nonChatModelPreferences, { image, classifier });
          assert.deepEqual(loaded.modelPresets, []);
          assert.equal(loaded.utilityModel, undefined);
          yield* updateNonChatModelPreference({ type: "image", preference: null });
          assert.deepEqual((yield* storage.load()).state.nonChatModelPreferences, { classifier });
          yield* updateNonChatModelPreference({ type: "classifier", preference: null });
          assert.deepEqual((yield* storage.load()).state.nonChatModelPreferences, {});
        }).pipe(
          Effect.provide(
            ApplicationState.layer.pipe(Layer.provide(Layer.succeed(ApplicationStorage)(storage))),
          ),
        ),
      ),
  );

  it.effect("uses explicit defaults for a missing file", () =>
    withStorage({}, (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load();
        assert.strictEqual(loaded.source, "missing");
        assert.deepStrictEqual(loaded.state, current);
      }),
    ),
  );

  it.effect("returns a typed read failure", () =>
    withStorage({ [documentPath]: "unreadable" }, (storage, controls) =>
      Effect.gen(function* () {
        controls.failRead = true;
        const error = yield* Effect.flip(storage.load());
        assert.equal(error._tag, "ApplicationReadError");
      }),
    ),
  );

  it.effect("loads a current version envelope", () =>
    withStorage({ [documentPath]: JSON.stringify({ version: 6, data: current }) }, (storage) =>
      Effect.gen(function* () {
        const loaded = yield* storage.load();
        assert.strictEqual(loaded.source, "current");
        assert.deepStrictEqual(loaded.state, current);
      }),
    ),
  );

  it.effect("defaults personal instructions in existing application and project settings", () =>
    withStorage(
      {
        [documentPath]: JSON.stringify({
          version: 6,
          data: {
            ...current,
            globalCustomInstructions: undefined,
            projects: [
              {
                path: "/work/cake",
                name: "Cake",
                addedAt: "2026-01-01T00:00:00.000Z",
                lastOpenedAt: "2026-01-01T00:00:00.000Z",
                settings: {
                  worktreeCreateCommand:
                    "git worktree add -b {branchName} {worktreePath} {baseCommit}",
                  worktreeSetupCommands: "pnpm install",
                },
              },
            ],
          },
        }),
      },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.strictEqual(loaded.source, "current");
          assert.equal(loaded.state.projects[0]?.settings?.worktreeSetupInstructions, "");
          assert.equal(loaded.state.projects[0]?.settings?.customInstructions, "");
          assert.equal(loaded.state.globalCustomInstructions, "");
        }),
    ),
  );

  it.effect("uses unset Cake prompts when migrating a version-four document", () => {
    const versionFour = { ...current };
    Reflect.deleteProperty(versionFour, "cakePrompts");
    return withStorage(
      { [documentPath]: JSON.stringify({ version: 4, data: versionFour }) },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.strictEqual(loaded.source, "migrated");
          assert.deepEqual(loaded.state.cakePrompts, {});
          assert.equal(
            resolveCakePrompts(loaded.state.cakePrompts).worktreeCommit,
            "Commit this change.",
          );
        }),
    );
  });

  it.effect("removes copied defaults from version five while preserving custom prompts", () =>
    Effect.gen(function* () {
      const oldCommitDefault =
        "Cake is preparing to merge this worktree into {{target}}, but it has uncommitted changes.\n\nInspect the complete working tree, verify the change, and commit all intended work with an appropriate commit message.\n\nDo not merge, rebase, push, switch branches, or modify the target checkout. Cake will merge the committed branch after this turn finishes.";
      for (const worktreeCommit of [
        oldCommitDefault,
        defaultCakePrompts().worktreeCommit,
        "Custom commit wording",
      ]) {
        yield* withStorage(
          {
            [documentPath]: JSON.stringify({
              version: 5,
              data: {
                ...current,
                cakePrompts: {
                  ...defaultCakePrompts(),
                  worktreeCommit,
                  worktreeSquashMessage: "Custom squash wording",
                },
              },
            }),
          },
          (storage, controls) =>
            Effect.gen(function* () {
              const loaded = yield* storage.load();
              const expected = {
                ...(worktreeCommit === "Custom commit wording" ? { worktreeCommit } : {}),
                worktreeSquashMessage: "Custom squash wording",
              };
              assert.equal(loaded.source, "migrated");
              assert.deepEqual(loaded.state.cakePrompts, expected);
              const persistedText = controls.files.get(documentPath);
              assert.ok(persistedText);
              assert.deepEqual(JSON.parse(persistedText).data.cakePrompts, expected);
              assert.equal((yield* storage.load()).source, "current");
            }),
        );
      }
    }),
  );

  it.effect("persists only custom overrides and resolves defaults after reset and reload", () =>
    withStorage({}, (storage, controls) =>
      Effect.gen(function* () {
        const application = yield* ApplicationState;
        yield* application.initialize();
        yield* setCakePrompts({ worktreeCommit: "Custom commit wording" });
        assert.deepEqual((yield* storage.load()).state.cakePrompts, {
          worktreeCommit: "Custom commit wording",
        });
        yield* setCakePrompts({
          worktreeCommit: "",
          worktreeSquashMessage: defaultCakePrompts().worktreeSquashMessage,
        });
        const loaded = yield* storage.load();
        assert.deepEqual(loaded.state.cakePrompts, {});
        const persistedText = controls.files.get(documentPath);
        assert.ok(persistedText);
        assert.deepEqual(JSON.parse(persistedText).data.cakePrompts, {});
        assert.deepEqual(resolveCakePrompts(loaded.state.cakePrompts), defaultCakePrompts());
      }).pipe(
        Effect.provide(
          ApplicationState.layer.pipe(Layer.provide(Layer.succeed(ApplicationStorage)(storage))),
        ),
      ),
    ),
  );

  it.effect("migrates recognized legacy and version-zero documents", () =>
    Effect.gen(function* () {
      for (const input of [legacy, { version: 0, data: legacy }]) {
        yield* withStorage({ [documentPath]: JSON.stringify(input) }, (storage, controls) =>
          Effect.gen(function* () {
            const loaded = yield* storage.load();
            assert.strictEqual(loaded.source, "migrated");
            assert.ok(!("resolvedSessionIds" in loaded.state));
            const persistedText = controls.files.get(documentPath);
            assert.ok(persistedText);
            const persisted = JSON.parse(persistedText);
            assert.strictEqual(persisted.version, 6);
            assert.ok(!("schemaVersion" in persisted.data));
          }),
        );
      }
    }),
  );

  it.effect("migrates project defaults into the global status catalog", () => {
    const featureId = "00000000-0000-4000-8000-000000000001";
    const versionOne = {
      projects: [
        {
          path: "/work/cake",
          name: "Cake",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastOpenedAt: "2026-01-01T00:00:00.000Z",
          workflow: {
            columns: [
              { id: featureId, name: "Feature", color: "blue" },
              {
                id: "b925b5dd-9661-4f1a-9f40-406be3c96c27",
                name: "In review",
                color: "cyan",
              },
            ],
            assignments: [{ sessionId: "session-1", statusId: featureId }],
            sessionDetails: [],
          },
        },
      ],
      unreadSessionIds: [],
      trustedProjectPaths: [],
      fastModeSessionIds: [],
      modelPresets: [],
    };
    return withStorage(
      { [documentPath]: JSON.stringify({ version: 1, data: versionOne }) },
      (storage) =>
        Effect.gen(function* () {
          const loaded = yield* storage.load();
          assert.strictEqual(loaded.source, "migrated");
          assert.equal(loaded.state.globalSessionLabels[0]?.name, "Feature");
          assert.deepEqual(
            loaded.state.projects[0]?.workflow?.labels.map((status) => status.name),
            ["In review"],
          );
          assert.deepEqual(loaded.state.projects[0]?.workflow?.assignments, [
            { sessionId: "session-1", labelIds: [featureId] },
          ]);
        }),
    );
  });

  it.effect("returns typed failures for malformed, future, and invalid documents", () =>
    Effect.gen(function* () {
      const cases = [
        ["{", ApplicationMalformedDocumentError],
        [JSON.stringify({ nope: true }), ApplicationMalformedDocumentError],
        [
          JSON.stringify({ version: 6, data: { ...current, projects: "invalid" } }),
          ApplicationDecodeError,
        ],
        [JSON.stringify({ version: 7, data: current }), ApplicationUnsupportedVersionError],
        [
          JSON.stringify({ version: 0, data: { schemaVersion: 1, projects: "invalid" } }),
          ApplicationMigrationError,
        ],
      ] as const;
      for (const [content, ErrorSchema] of cases) {
        yield* withStorage({ [documentPath]: content }, (storage) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(storage.load());
            assert.ok(Schema.is(ErrorSchema)(error));
          }),
        );
      }
    }),
  );

  it.effect(
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

  it.effect("cleans a temporary file when an in-progress write is interrupted", () =>
    withStorage({ [documentPath]: "previous" }, (storage, controls) =>
      Effect.gen(function* () {
        controls.interruptWrite = true;
        const fiber = yield* Effect.forkChild(storage.save(current));
        yield* Deferred.await(controls.writeStarted);
        assert.strictEqual(controls.temporaryFiles().length, 1);
        yield* Fiber.interrupt(fiber);
        assert.strictEqual(controls.files.get(documentPath), "previous");
        assert.deepStrictEqual(controls.temporaryFiles(), []);
      }),
    ),
  );

  it.effect("serializes concurrent writes", () =>
    withStorage({}, (storage, controls) =>
      Effect.gen(function* () {
        controls.blockWrites = true;
        const first = yield* Effect.forkChild(storage.save(current));
        yield* Deferred.await(controls.writeStarted);
        assert.strictEqual(controls.activeWrites, 1);
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
